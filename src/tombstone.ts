// tombstone.ts — soft-delete + gc-guard + partial legal-hold over the append-only log.
//
// Soft-delete is a compensating event (`tombstone.hide`), never a rewrite:
// the target line stays in the log (auditable, syncable, replayable) and the
// read-model hides it by convention. GC-guard (`guardSeal`) keeps `truncate`
// honest: a seal that would split a hide/target pair or sweep a held event
// clamps down instead of deleting. Legal-hold is partial (per event id, not
// the whole log) and local (stored in `_meta`, like the snapshot seal —
// set it per replica, it does not sync).
//
// This module only uses the public EventStore/Kernel surface; it changes no
// existing file and adds no schema migration.
import { clampSealToStored } from './retain.js';
import type { LogEvent } from './log.js';
import type { EventStore } from './store.js';
import type { AppendArgs } from './kernel.js';

/** Compensating event: hide `payload.hides` (an event id) from visible reads. */
export const TOMBSTONE_HIDE = 'tombstone.hide';
/** Compensating event: lift the hide on `payload.shows` (an event id). */
export const TOMBSTONE_SHOW = 'tombstone.show';

/** `_meta` key prefix for local legal-holds; the suffix is the held event id. */
const HOLD_PREFIX = 'tombstone.hold.';

/** Minimal kernel surface this module needs (append + read). */
export interface Hider {
  append(args: AppendArgs): Promise<LogEvent>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]>;
}

export interface TombstoneOp {
  seq: number;
  op: 'hide' | 'show';
  target: string;
}

export interface Hold {
  id: string;
  reason: string;
  /** Live log seq, or null when the event is not in this replica's store. */
  seq: number | null;
  /** True when this hold forced the seal down. */
  blocks: boolean;
}

/** A tombstone/target split: the target seq plus the tombstone-op seq the
 *  seal would strand on the other side of the sweep boundary. `hide` keeps
 *  its name for existing callers; it holds the op seq for a hide or a show.
 */
export interface SplitPair {
  target: number;
  hide: number;
}

export interface GuardReport {
  /** Seal the caller may safely sweep (0 = sweep nothing). */
  effective: number;
  /** Every hold on this replica and whether it blocked the sweep. */
  held: Hold[];
  /** Tombstone/target pairs the seal would have split (clamped below both). */
  pairs: SplitPair[];
}

/** Tombstone ops in seq order; malformed bodies are skipped, never fatal. */
export function listTombstones(store: EventStore): TombstoneOp[] {
  const rows = store.query<{ seq: number; type: string; body: string }>(
    `SELECT seq, type, body FROM records WHERE type = '${TOMBSTONE_HIDE}' OR type = '${TOMBSTONE_SHOW}' ORDER BY seq`,
  );
  const ops: TombstoneOp[] = [];
  for (const r of rows) {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.type === TOMBSTONE_HIDE && typeof body['hides'] === 'string') {
      ops.push({ seq: r.seq, op: 'hide', target: body['hides'] as string });
    } else if (r.type === TOMBSTONE_SHOW && typeof body['shows'] === 'string') {
      ops.push({ seq: r.seq, op: 'show', target: body['shows'] as string });
    }
  }
  return ops;
}

/** Ids hidden right now: hides add, shows lift, folded in seq order. */
export function hiddenIds(store: EventStore): Set<string> {
  const hidden = new Set<string>();
  for (const op of listTombstones(store)) {
    if (op.op === 'hide') hidden.add(op.target);
    else hidden.delete(op.target);
  }
  return hidden;
}

export function isHidden(store: EventStore, id: string): boolean {
  return hiddenIds(store).has(id);
}

/** Module mutex: serializes check-then-append in hide/show so concurrent
 *  callers need no outer lock. Cooperative (same process), like the kernel
 *  append/truncate chain. */
let chain: Promise<void> = Promise.resolve();
function runAtomic<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function storedIds(k: Hider): Promise<Set<string>> {
  const rows = await k.query<{ id: string }>(`SELECT id FROM _events`);
  return new Set(rows.map((r) => r.id));
}

/** Tombstone fold over the kernel's view: ids hidden right now. */
async function hiddenIdsOf(k: Hider): Promise<Set<string>> {
  const rows = await k.query<{ type: string; payload: unknown }>(
    `SELECT type, payload FROM _events WHERE type IN ('${TOMBSTONE_HIDE}', '${TOMBSTONE_SHOW}') ORDER BY seq`,
  );
  const hidden = new Set<string>();
  for (const r of rows) {
    const p =
      typeof r.payload === 'string'
        ? (JSON.parse(r.payload) as Record<string, unknown>)
        : (r.payload as Record<string, unknown>);
    if (r.type === TOMBSTONE_HIDE && typeof p?.hides === 'string') hidden.add(p.hides);
    else if (r.type === TOMBSTONE_SHOW && typeof p?.shows === 'string') hidden.delete(p.shows);
  }
  return hidden;
}

/** Fail-loud when `k` and `store` are not the same replica. Compares the
 *  exposed store identity when available, then requires both views to agree
 *  on whether the target is stored. */
async function assertPairedStore(k: Hider, store: EventStore, targetId: string): Promise<void> {
  if (k !== null && typeof k === 'object' && 'store' in k) {
    const inner: unknown = k.store;
    if (inner !== undefined && inner !== store) {
      throw new Error(`ERR_STORE_MISMATCH: tombstone.show needs k and store on the same replica`);
    }
  }
  const kHas = (await storedIds(k)).has(targetId);
  const sHas = store.hasId(targetId);
  if (kHas !== sHas) {
    throw new Error(`ERR_STORE_MISMATCH: tombstone.show needs k and store on the same replica`);
  }
}

/**
 * Soft-delete: append a `tombstone.hide` compensating event. The target line
 * stays in the log; readers via `isHidden`/`hiddenIds` exclude it. Throws
 * `ERR_UNKNOWN_TARGET` before appending when the target is not stored, so a
 * typo never leaves a poison line behind.
 *
 * Atomic: the stored-target check and the append run under a module mutex,
 * so concurrent `hide()` calls need no outer lock. A second concurrent hide
 * of an already-hidden id is an exactly-once no-op — it returns the existing
 * hide event instead of appending a duplicate.
 */
export async function hide(
  k: Hider,
  targetId: string,
  opts?: { actor?: string; reason?: string },
): Promise<LogEvent> {
  return runAtomic(async () => {
    if (!(await storedIds(k)).has(targetId)) {
      throw new Error(`ERR_UNKNOWN_TARGET: tombstone.hide needs a stored event id (got ${targetId})`);
    }
    if ((await hiddenIdsOf(k)).has(targetId)) {
      const rows = await k.query<{ id: string; type: string; payload: unknown }>(
        `SELECT id, type, payload FROM _events WHERE type = '${TOMBSTONE_HIDE}' ORDER BY seq`,
      );
      for (const r of rows) {
        const p =
          typeof r.payload === 'string'
            ? (JSON.parse(r.payload) as Record<string, unknown>)
            : (r.payload as Record<string, unknown>);
        if (p?.hides === targetId) {
          const found = await k.query<Record<string, unknown>>(
            `SELECT * FROM _events WHERE id = '${r.id.replace(/'/g, "''")}'`,
          );
          const row = found[0];
          if (row) {
            const raw = row['payload'];
            return { ...(row as unknown as LogEvent), payload: typeof raw === 'string' ? JSON.parse(raw) : raw };
          }
          break;
        }
      }
    }
    return k.append({
      type: TOMBSTONE_HIDE,
      payload: { hides: targetId, ...(opts?.reason ? { reason: opts.reason } : {}) },
      ...(opts?.actor ? { actor: opts.actor } : {}),
    });
  });
}

/**
 * Lift a soft-delete. Throws `ERR_NOT_HIDDEN` when the id is not hidden, so
 * a stray show never leaves a poison line behind. Throws `ERR_STORE_MISMATCH`
 * when `k` and `store` are not the same replica. Atomic with `hide()` under
 * the module mutex, so no outer lock is needed.
 */
export async function show(
  k: Hider,
  store: EventStore,
  targetId: string,
  opts?: { actor?: string },
): Promise<LogEvent> {
  return runAtomic(async () => {
    if (!isHidden(store, targetId)) {
      throw new Error(`ERR_NOT_HIDDEN: tombstone.show needs a hidden event id (got ${targetId})`);
    }
    await assertPairedStore(k, store, targetId);
    return k.append({
      type: TOMBSTONE_SHOW,
      payload: { shows: targetId },
      ...(opts?.actor ? { actor: opts.actor } : {}),
    });
  });
}

/** Local legal-hold on one event id. Throws `ERR_UNKNOWN_TARGET` when absent. */
export function hold(store: EventStore, id: string, reason: string): void {
  if (!store.getEventById(id)) {
    throw new Error(`ERR_UNKNOWN_TARGET: hold needs a stored event id (got ${id})`);
  }
  store.setMeta(HOLD_PREFIX + id, reason);
}

export function release(store: EventStore, id: string): void {
  store.exec(`DELETE FROM _meta WHERE k = '${(HOLD_PREFIX + id).replace(/'/g, "''")}'`);
}

export function isHeld(store: EventStore, id: string): boolean {
  return store.getMeta(HOLD_PREFIX + id) !== null;
}

/** Every hold on this replica with its live seq (null when not stored here). */
export function holds(store: EventStore): Array<{ id: string; reason: string; seq: number | null }> {
  const rows = store.query<{ k: string; v: string }>(
    `SELECT k, v FROM _meta WHERE k LIKE '${HOLD_PREFIX}%'`,
  );
  return rows.map((r) => ({
    id: r.k.slice(HOLD_PREFIX.length),
    reason: r.v,
    seq: store.getEventById(r.k.slice(HOLD_PREFIX.length))?.seq ?? null,
  }));
}

/**
 * GC-guard: clamp a truncate seal so it never (a) removes unacked/unapplied
 * data (via `clampSealToStored`), (b) sweeps a legally-held event, or
 * (c) splits a tombstone/target pair across the sweep boundary (a swept
 * target whose hide or show survives — or vice versa — would resurrect or
 * orphan on replay). Returns the safe seal plus exactly what forced it down,
 * so the caller can report held-vs-swept honestly instead of claiming deletion.
 */
export function guardSeal(
  store: EventStore,
  logSeqs: number[],
  sealed: number,
  ackSeq: number,
): GuardReport {
  let effective = clampSealToStored(store, logSeqs, sealed, ackSeq);
  const held: Hold[] = [];
  for (const h of holds(store)) {
    if (h.seq !== null && h.seq <= effective) {
      effective = h.seq - 1;
      held.push({ ...h, blocks: true });
    } else {
      held.push({ ...h, blocks: false });
    }
  }
  // Tombstone/target pairs sweep atomically: fixpoint, because clamping for
  // one pair can expose a split in another. Hides and shows both count — a
  // swept target whose show survives (or vice versa) would resurrect or
  // orphan on replay, same as a split hide.
  const pairs: SplitPair[] = [];
  for (;;) {
    let split: SplitPair | null = null;
    for (const op of listTombstones(store)) {
      const targetSeq = store.getEventById(op.target)?.seq;
      if (targetSeq === undefined || targetSeq === null) continue; // pair already gone
      const tIn = targetSeq <= effective;
      const hIn = op.seq <= effective;
      if (tIn !== hIn) {
        split = { target: targetSeq, hide: op.seq };
        break;
      }
    }
    if (!split) break;
    pairs.push(split);
    effective = Math.min(split.target, split.hide) - 1;
    if (effective <= 0) {
      effective = 0;
      break;
    }
  }
  return { effective, held, pairs };
}
