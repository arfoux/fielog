// store.ts — SQLite read-model: apply/replay/materialize over the log.
// kasir.db is plain SQLite (opens in DBeaver). Bun runtime: bun:sqlite.
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
  if (type === 'bayar') {
    const nominal = Number(p['nominal']);
    if (!Number.isFinite(nominal) || nominal <= 0) {
      throw new Error(`bayar rejected: nominal must be a positive number (got ${String(p['nominal'])})`);
    }
    const state = String(p['state'] ?? MoneyState.IOU_RECORDED);
    if (!MONEY_APPEND_STATES[state]) {
      throw new Error(
        `bayar rejected: state '${state}' cannot be recorded offline (use DRAFT or IOU_RECORDED; settlement needs online ack)`,
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
CREATE TABLE IF NOT EXISTS bayar(
  seq INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  nominal INTEGER NOT NULL,
  oleh TEXT,
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

export interface EventStore {
  apply(ev: LogEvent): void;
  replay(events: LogEvent[]): void;
  query<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
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
    // Idempotent by UUID: replays / pulled duplicates are no-ops.
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
      if (String((err as Error)?.message ?? err).includes('UNIQUE')) return false;
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
    } catch {
      /* same conflict re-applied during replay — keep the first row */
    }
  }

  function route(ev: LogEvent): void {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case 'bayar': {
        checkAppend(ev.type, p);
        const nominal = Number(p['nominal']);
        const state = String(p['state'] ?? MoneyState.IOU_RECORDED);
        run(
          db,
          `INSERT INTO bayar(seq,event_id,nominal,oleh,state,voided) VALUES(?,?,?,?,?,0)`,
          ev.seq,
          ev.id,
          nominal,
          (p['oleh'] as string) ?? (ev.actor as string) ?? null,
          state,
        );
        break;
      }
      case 'payment.settled':
      case 'payment.failed':
      case 'payment.expired': {
        const target = String(p['event_id'] ?? p['reverses'] ?? '');
        const rows = all<{ state: string; voided: number }>(
          db,
          `SELECT state, voided FROM bayar WHERE event_id = ?`,
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
        run(db, `UPDATE bayar SET state = ? WHERE event_id = ?`, next, target);
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
        break;
      }
      case 'undo.compensate': {
        const target = String(p['reverses'] ?? '');
        const b = all<{ seq: number }>(db, `SELECT seq FROM bayar WHERE event_id = ?`, target);
        if (b.length) {
          run(db, `UPDATE bayar SET voided = 1 WHERE event_id = ?`, target);
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

  const store: EventStore = {
    apply(ev: LogEvent): void {
      if (!insertRaw(ev)) return; // idempotent by UUID
      route(ev);
    },
    replay(events: LogEvent[]): void {
      db.exec('DELETE FROM _events; DELETE FROM bayar; DELETE FROM stock; DELETE FROM stock_moves; DELETE FROM conflicts; DELETE FROM records;');
      for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
        if (!insertRaw(ev)) continue;
        route(ev);
      }
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
      return {
        seq: r.seq, id: r.id, type: r.type, actor: r.actor ?? undefined,
        device_id: r.device_id, ts_device: r.ts_device,
        server_time: r.server_time ?? undefined,
        payload: JSON.parse(r.payload), hash: r.hash, prev_hash: r.prev_hash,
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
