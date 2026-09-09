// store.ts — SQLite read-model: apply/replay/materialize over the log.
// ledger.db is plain SQLite (opens in DBeaver). Bun runtime: bun:sqlite.
import { Database } from 'bun:sqlite';
import type { LogEvent } from './log.js';

export type SqlParams = Record<string, unknown> | unknown[];

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
  close(): void;
};

/** bun:sqlite wants prefixed named params ($id); accept bare keys too. */
function named(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k.startsWith('$') || k.startsWith(':') || k.startsWith('@') ? k : `$${k}`] = v;
  }
  return out;
}

function openDb(path: string): Db {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  return {
    exec: (sql: string) => {
      db.exec(sql);
    },
    prepare: (sql: string) => {
      const s = db.prepare(sql) as unknown as {
        all(...p: unknown[]): unknown[];
        run(...p: unknown[]): void;
      };
      const shape = (p: unknown[]) =>
        p.length === 1 && typeof p[0] === 'object' && p[0] !== null && !Array.isArray(p[0])
          ? [named(p[0] as Record<string, unknown>)]
          : p;
      return {
        all: (...p: unknown[]) => s.all(...shape(p)),
        run: (...p: unknown[]) => {
          s.run(...shape(p));
        },
      };
    },
    close: () => db.close(),
  };
}

// Money honesty: offline money is an IOU, never payment.
export const MoneyState = {
  DRAFT: 'DRAFT',
  IOU_RECORDED: 'IOU_RECORDED', // recorded locally, NOT paid
  SETTLED_ONLINE: 'SETTLED_ONLINE', // only via settle/sync ack
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type MoneyState = (typeof MoneyState)[keyof typeof MoneyState];

const MONEY_APPEND_STATES: Record<string, true> = { [MoneyState.DRAFT]: true, [MoneyState.IOU_RECORDED]: true };
const TERMINAL_STATES: Record<string, true> = {
  [MoneyState.SETTLED_ONLINE]: true,
  [MoneyState.FAILED]: true,
  [MoneyState.EXPIRED]: true,
};
/**
 * Fail-fast input validation. Kernel runs this BEFORE touching the log so a
 * rejected append leaves no poison line behind (replay stays total).
 */
export function checkAppend(type: string, payload: Record<string, unknown>): void {
  const p = payload ?? {};
  if (type === 'payment') {
    const amount = Number(p['amount']);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      throw new Error(`payment rejected: amount must be a positive integer (got ${String(p['amount'])})`);
    }
    const state = String(p['state'] ?? MoneyState.IOU_RECORDED);
    if (!MONEY_APPEND_STATES[state]) {
      throw new Error(
        `payment rejected: state '${state}' cannot be recorded offline (use DRAFT or IOU_RECORDED; settlement needs online ack)`,
      );
    }
  } else if (type === 'stock.add') {
    if (!String(p['item']) || !Number.isFinite(Number(p['qty']))) throw new Error('stock.add needs {item, qty}');
  } else if (type === 'stock.sell') {
    if (!String(p['item']) || !Number.isFinite(Number(p['qty'])) || Number(p['qty']) <= 0) {
      throw new Error('stock.sell needs {item, qty>0}');
    }
  }
}

function run(db: Db, sql: string, ...params: unknown[]): void {
  void db.prepare(sql).run(...params);
}

function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS _events(
  seq INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  device_id TEXT NOT NULL,
  ts_device INTEGER NOT NULL,
  server_time INTEGER,
  payload TEXT NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment(
  seq INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  amount INTEGER NOT NULL,
  actor TEXT,
  state TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stock(
  item TEXT PRIMARY KEY,
  qty INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stock_moves(
  seq INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  item TEXT NOT NULL,
  qty INTEGER NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conflicts(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  event_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS records(
  seq INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL
);
`;

export interface ReplayResult {
  /** Events durably applied by this call (idempotent replays excluded). */
  applied: number;
  /** Poison events rolled back alone so the tail behind them still applied. */
  skipped: number;
}

export interface EventStore {
  apply(ev: LogEvent): void;
  /** Catch-up apply of events missing locally; never deletes (truncate-safe). */
  replay(events: LogEvent[]): ReplayResult;
  /**
   * Delete read-model rows for seqs the log no longer carries (quarantined),
   * forgiving the swept prefix below `forgiveBelow`. Returns excised count.
   */
  exciseMissing(kept: number[], forgiveBelow: number): number;
  query<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
  /** Raw DDL/admin (VACUUM INTO for snapshots). No placeholder support. */
  exec(sql: string): void;
  getEventById(id: string): LogEvent | null;
  hasId(id: string): boolean;
  getMeta(k: string): string | null;
  setMeta(k: string, v: string): void;
  close(): void;
}

export function openStore(path: string): EventStore {
  const db = openDb(path);
  db.exec(SCHEMA);

  function insertRaw(ev: LogEvent): boolean {
    // Idempotent by UUID: replays / pulled duplicates are no-ops. But a seq
    // collision under a FRESH id is chain corruption, never a replay — it
    // must fail loud instead of silently dropping the event.
    try {
      run(
        db,
        `INSERT INTO _events(seq,id,type,actor,device_id,ts_device,server_time,payload,hash,prev_hash)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ev.seq,
        ev.id,
        ev.type,
        ev.actor ?? null,
        ev.device_id,
        ev.ts_device,
        ev.server_time ?? null,
        JSON.stringify(ev.payload),
        ev.hash,
        ev.prev_hash,
      );
      return true;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!msg.includes('UNIQUE') && !msg.includes('PRIMARY')) throw err;
      if (msg.includes('_events.id')) return false; // idempotent replay by UUID
      // Exact re-inserts can trip the seq check first: still a replay when
      // THIS id is already stored. A fresh id on a taken seq is corruption.
      const known = all(db, `SELECT 1 FROM _events WHERE id = ? LIMIT 1`, ev.id).length > 0;
      if (known) return false;
      throw err;
    }
  }
  function addConflict(kind: string, detail: string, eventIds: string[]): void {
    const id = `cf-${eventIds.join('-')}-${kind}`;
    try {
      run(
        db,
        `INSERT INTO conflicts(id,kind,detail,event_ids,status) VALUES(?,?,?,?, 'open')`,
        id,
        kind,
        detail,
        JSON.stringify(eventIds),
      );
    } catch (err) {
      // Same conflict re-applied during replay — keep the first row. Anything
      // else (disk full, IO, locking) must surface, never swallow.
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes('UNIQUE') || msg.includes('PRIMARY')) return;
      throw err;
    }
  }

  // Reorder resurrection: an undo/transition that arrived before its target
  // parks in records (undo) or conflicts (unknown-payment). When the target
  // lands later, re-resolve here so voided/state converge regardless of order.
  function resolvePendingUndos(target: string): void {
    const rows = all<{ event_id: string; body: string }>(
      db,
      `SELECT event_id, body FROM records WHERE type = 'undo.compensate'`,
    );
    for (const r of rows) {
      let reverses = '';
      try {
        reverses = String((JSON.parse(r.body) as Record<string, unknown>)['reverses'] ?? '');
      } catch {
        continue;
      }
      if (reverses !== target) continue;
      const b = all<{ seq: number }>(db, `SELECT seq FROM payment WHERE event_id = ?`, target);
      if (b.length) {
        run(db, `UPDATE payment SET voided = 1 WHERE event_id = ?`, target);
        continue;
      }
      const m = all<{ item: string; qty: number; voided: number }>(
        db,
        `SELECT item, qty, voided FROM stock_moves WHERE event_id = ?`,
        target,
      );
      if (m.length && !m[0].voided) {
        run(db, `UPDATE stock_moves SET voided = 1 WHERE event_id = ?`, target);
        run(
          db,
          `INSERT INTO stock(item,qty) VALUES(?,?)
           ON CONFLICT(item) DO UPDATE SET qty = stock.qty + excluded.qty`,
          m[0].item,
          -m[0].qty,
        );
      }
    }
  }

  function resolvePendingPayments(target: string): void {
    const open = all<{ id: string; event_ids: string }>(
      db,
      `SELECT id, event_ids FROM conflicts WHERE kind = 'unknown-payment' AND status = 'open'`,
    );
    const cands: Array<{ id: string; type: string; seq: number; conflictId: string }> = [];
    for (const c of open) {
      let ids: string[] = [];
      try {
        ids = JSON.parse(c.event_ids) as string[];
      } catch {
        continue;
      }
      for (const tid of ids) {
        const er = all<{ type: string; seq: number; payload: string }>(
          db,
          `SELECT type, seq, payload FROM _events WHERE id = ?`,
          tid,
        );
        if (!er.length) continue;
        let pp: Record<string, unknown> = {};
        try {
          pp = JSON.parse(er[0].payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (String(pp['event_id'] ?? pp['reverses'] ?? '') !== target) continue;
        cands.push({ id: tid, type: er[0].type, seq: er[0].seq, conflictId: c.id });
      }
    }
    cands.sort((a, b) => a.seq - b.seq);
    for (const t of cands) {
      const rows = all<{ state: string }>(db, `SELECT state FROM payment WHERE event_id = ?`, target);
      if (!rows.length) continue;
      if (TERMINAL_STATES[rows[0].state]) {
        // Target landed terminal already: morph into a double-settle for humans.
        run(db, `UPDATE conflicts SET kind = 'double-settle', detail = ?, event_ids = ? WHERE id = ?`,
          `${t.type} on already-terminal payment ${target} (${rows[0].state})`,
          JSON.stringify([target, t.id]),
          t.conflictId);
        continue;
      }
      const next =
        t.type === 'payment.settled'
          ? MoneyState.SETTLED_ONLINE
          : t.type === 'payment.failed'
            ? MoneyState.FAILED
            : MoneyState.EXPIRED;
      run(db, `UPDATE payment SET state = ? WHERE event_id = ?`, next, target);
      run(db, `UPDATE conflicts SET status = 'resolved' WHERE id = ?`, t.conflictId);
    }
  }

  function route(ev: LogEvent): void {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case 'payment': {
        checkAppend(ev.type, p);
        const amount = Number(p['amount']);
        const state = String(p['state'] ?? MoneyState.IOU_RECORDED);
        run(
          db,
          `INSERT INTO payment(seq,event_id,amount,actor,state,voided) VALUES(?,?,?,?,?,0)`,
          ev.seq,
          ev.id,
          amount,
          (p['actor'] as string) ?? (ev.actor as string) ?? null,
          state,
        );
        // Target landed after its undo/transition parked: resurrect them now.
        resolvePendingUndos(ev.id);
        resolvePendingPayments(ev.id);
        break;
      }
      case 'payment.settled':
      case 'payment.failed':
      case 'payment.expired': {
        const target = String(p['event_id'] ?? p['reverses'] ?? '');
        const rows = all<{ state: string; voided: number }>(
          db,
          `SELECT state, voided FROM payment WHERE event_id = ?`,
          target,
        );
        if (rows.length === 0) {
          addConflict('unknown-payment', `transition ${ev.type} references unknown payment ${target}`, [ev.id]);
          break;
        }
        if (TERMINAL_STATES[rows[0].state]) {
          // Double-settle / settle-after-fail: human must reconcile, never LWW.
          addConflict(
            'double-settle',
            `${ev.type} on already-terminal payment ${target} (${rows[0].state})`,
            [target, ev.id],
          );
          break;
        }
        const next =
          ev.type === 'payment.settled'
            ? MoneyState.SETTLED_ONLINE
            : ev.type === 'payment.failed'
              ? MoneyState.FAILED
              : MoneyState.EXPIRED;
        run(db, `UPDATE payment SET state = ? WHERE event_id = ?`, next, target);
        break;
      }
      case 'stock.add': {
        checkAppend(ev.type, p);
        const item = String(p['item']);
        const qty = Number(p['qty']);
        run(
          db,
          `INSERT INTO stock(item,qty) VALUES(?,?)
           ON CONFLICT(item) DO UPDATE SET qty = stock.qty + excluded.qty`,
          item,
          qty,
        );
        run(db, `INSERT INTO stock_moves(seq,event_id,item,qty,voided) VALUES(?,?,?, ?,0)`, ev.seq, ev.id, item, qty);
        resolvePendingUndos(ev.id);
        break;
      }
      case 'stock.sell': {
        checkAppend(ev.type, p);
        const item = String(p['item']);
        const qty = Number(p['qty']);
        const rows = all<{ qty: number }>(db, `SELECT qty FROM stock WHERE item = ?`, item);
        const onHand = rows.length ? rows[0].qty : 0;
        if (qty > onHand) {
          // Contended stock: explicit conflict row, move parked as voided. Never silent LWW.
          run(db, `INSERT INTO stock_moves(seq,event_id,item,qty,voided) VALUES(?,?,?,? ,1)`, ev.seq, ev.id, item, -qty);
          addConflict(
            'oversell',
            `sell ${qty}×${item} with ${onHand} on hand (event ${ev.id})`,
            [ev.id],
          );
        } else {
          run(db, `UPDATE stock SET qty = qty - ? WHERE item = ?`, qty, item);
          run(db, `INSERT INTO stock_moves(seq,event_id,item,qty,voided) VALUES(?,?,?, ?,0)`, ev.seq, ev.id, item, -qty);
        }
        resolvePendingUndos(ev.id);
        break;
      }
      case 'undo.compensate': {
        const target = String(p['reverses'] ?? '');
        const b = all<{ seq: number }>(db, `SELECT seq FROM payment WHERE event_id = ?`, target);
        if (b.length) {
          run(db, `UPDATE payment SET voided = 1 WHERE event_id = ?`, target);
          break;
        }
        const m = all<{ item: string; qty: number; voided: number }>(
          db,
          `SELECT item, qty, voided FROM stock_moves WHERE event_id = ?`,
          target,
        );
        if (m.length && !m[0].voided) {
          run(db, `UPDATE stock_moves SET voided = 1 WHERE event_id = ?`, target);
          // Reverse the physical effect: moves store signed qty, so subtract it back.
          run(
            db,
            `INSERT INTO stock(item,qty) VALUES(?,?)
             ON CONFLICT(item) DO UPDATE SET qty = stock.qty + excluded.qty`,
            m[0].item,
            -m[0].qty,
          );
          break;
        }
        run(db, `INSERT INTO records(seq,event_id,type,body) VALUES(?,?,?,?)`, ev.seq, ev.id, ev.type, JSON.stringify(p));
        break;
      }
      default: {
        run(db, `INSERT INTO records(seq,event_id,type,body) VALUES(?,?,?,?)`, ev.seq, ev.id, ev.type, JSON.stringify(p));
        break;
      }
    }
  }

  /**
   * Forensic quarantine for a corrupt _events row, mirroring sync.ts: the
   * _events row stays (reopen replay stays a no-op by UUID) while the domain
   * views stop serving it. Schema matches ensureQuarantine in sync.ts.
   * Best-effort on a read path: never throws.
   */
  function quarantineCorruptRow(r: { id: string; seq: number }): void {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        run(
          db,
          `CREATE TABLE IF NOT EXISTS _quarantine(event_id TEXT PRIMARY KEY, reason TEXT NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL)`,
        );
        const raw = all<Record<string, unknown>>(db, `SELECT * FROM _events WHERE id = ?`, r.id);
        run(
          db,
          `INSERT OR IGNORE INTO _quarantine(event_id, reason, ts, event) VALUES(?,?,?,?)`,
          r.id,
          `corrupt-payload seq=${r.seq}`,
          Date.now(),
          raw.length ? JSON.stringify(raw[0]) : r.id,
        );
        run(db, `DELETE FROM payment WHERE event_id = ?`, r.id);
        const m = all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM stock_moves WHERE event_id = ?`, r.id);
        run(db, `DELETE FROM stock_moves WHERE event_id = ?`, r.id);
        run(db, `DELETE FROM records WHERE event_id = ?`, r.id);
        if ((m[0]?.n ?? 0) > 0) {
          // Balances derive from moves: rebuild atomically with the purge.
          db.exec(`DELETE FROM stock`);
          run(
            db,
            `INSERT INTO stock(item, qty) SELECT item, SUM(qty) FROM stock_moves WHERE voided = 0 GROUP BY item`,
          );
        }
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
      }
    } catch {
      /* read path: the row is still unreadable, so callers see absence */
    }
  }

  const store: EventStore = {
    apply(ev: LogEvent): void {
      // Atomic: _events row + routed rows commit together. A kill between
      // them used to orphan the UUID and blind replay forever.
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!insertRaw(ev)) {
          db.exec('ROLLBACK');
          return; // idempotent by UUID
        }
        route(ev);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    },
    replay(events: LogEvent[]): ReplayResult {
      // Incremental only: the store can hold events the log no longer carries
      // (post-truncate). Clearing here would wipe a healthy read-model.
      // Per-event transaction: one poison event rolls back alone instead of
      // starving the tail behind it. The skip count is returned so callers
      // can surface poison instead of silently losing it.
      let applied = 0;
      let skipped = 0;
      for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!insertRaw(ev)) {
            db.exec('ROLLBACK');
            continue;
          }
          route(ev);
          db.exec('COMMIT');
          applied += 1;
        } catch {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* already rolled back */
          }
          skipped += 1;
        }
      }
      return { applied, skipped };
    },
    exciseMissing(kept: number[], forgiveBelow: number): number {
      const have = new Set(kept);
      const rows = all<{ seq: number; id: string }>(db, `SELECT seq, id FROM _events`);
      const gone = rows.filter((r) => !have.has(r.seq) && r.seq >= forgiveBelow);
      if (gone.length === 0) return 0;
      // One transaction: a failure mid-sweep (disk, lock, trigger) rolls the
      // whole excise back instead of leaving half-deleted views behind, and
      // the stock rebuild below commits atomically with the deletes above.
      db.exec('BEGIN IMMEDIATE');
      try {
        let moves = 0;
        for (const g of gone) {
          run(db, `DELETE FROM payment WHERE event_id = ?`, g.id);
          const m = all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM stock_moves WHERE event_id = ?`, g.id);
          if (m[0]?.n) moves += 1;
          run(db, `DELETE FROM stock_moves WHERE event_id = ?`, g.id);
          run(db, `DELETE FROM records WHERE event_id = ?`, g.id);
          run(db, `DELETE FROM _events WHERE id = ?`, g.id);
        }
        if (moves > 0) {
          // Balances derive from moves: rebuild so excised stock stops counting.
          db.exec('DELETE FROM stock');
          run(
            db,
            `INSERT INTO stock(item, qty) SELECT item, SUM(qty) FROM stock_moves WHERE voided = 0 GROUP BY item`,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
      return gone.length;
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    query<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
      const stmt = db.prepare(sql);
      if (params === undefined) return stmt.all() as T[];
      if (Array.isArray(params)) return stmt.all(...params) as T[];
      return stmt.all(params) as T[];
    },
    getEventById(id: string): LogEvent | null {
      const rows = all<{
        seq: number; id: string; type: string; actor: string | null; device_id: string;
        ts_device: number; server_time: number | null; payload: string; hash: string; prev_hash: string;
      }>(db, `SELECT * FROM _events WHERE id = ?`, id);
      if (!rows.length) return null;
      const r = rows[0];
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(r.payload) as Record<string, unknown>;
      } catch {
        payload = null as unknown as Record<string, unknown>;
      }
      if (payload === null || typeof payload !== 'object') {
        // Corrupt _events payload (bit-rot, bad merge): quarantine the row —
        // evidence kept, domain views purged — and report absence instead of
        // throwing out of a read path (sync/tombstone call this in loops).
        quarantineCorruptRow(r);
        return null;
      }
      return {
        seq: r.seq, id: r.id, type: r.type, actor: r.actor ?? undefined,
        device_id: r.device_id, ts_device: r.ts_device,
        server_time: r.server_time ?? undefined,
        payload, hash: r.hash, prev_hash: r.prev_hash,
      };
    },
    hasId(id: string): boolean {
      return all(db, `SELECT 1 FROM _events WHERE id = ? LIMIT 1`, id).length > 0;
    },
    getMeta(k: string): string | null {
      const rows = all<{ v: string }>(db, `SELECT v FROM _meta WHERE k = ?`, k);
      return rows.length ? rows[0].v : null;
    },
    setMeta(k: string, v: string): void {
      run(db, `INSERT INTO _meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
    },
    close(): void {
      db.close();
    },
  };
  return store;
}
