// kernel.ts — createKernel({file}): append/query/undo/sync.
// Local-first: append/query/undo NEVER touch the network. Sync is background
// delta handled by sync.ts against a Relay object.
import { randomUUID } from 'node:crypto';
import { openLog, type AppendLog, type AppendInput, type LogEvent } from './log.js';
import { checkAppend, openStore, type EventStore, type SqlParams } from './store.js';
import {
  createFailoverState,
  getAckSeq,
  getServerTime,
  syncKernel as runSync,
  syncWithFailover,
  type FailoverState,
  type PushResult,
  type PullResult,
  type Relay,
  type SyncOpts,
} from './sync.js';
import { clampSealToStored, takeSnapshot, sweepLogFile } from './retain.js';
import { mintCapToken, signEvent, type CapToken } from './auth.js';

export interface KernelOpts {
  file: string; // e.g. 'kasir.db' (+ sidecar 'kasir.log')
  deviceId?: string;
  /** Wall-clock source for ts_device (display only, never order). Test seam for skew. */
  clock?: () => number;
  /** Max locally queued events awaiting ack (default 50_000). Append past it throws ERR_OUTBOX_FULL. */
  maxPending?: number;
  /** ed25519 private key PEM: every local append is signed at source, so
   * trusted-mode receivers verify (not dead-letter) legitimate traffic. */
  privateKeyPem?: string;
}

/** Default bound on unsynced outbox events before append refuses with ERR_OUTBOX_FULL. */
export const DEFAULT_OUTBOX_CAP = 50_000;

export type AppendArgs =
  | { type: string; payload: Record<string, unknown>; actor?: string }
  | ({ type: string; actor?: string } & Record<string, unknown>);

export interface LogHealth {
  events: number;
  quarantined: number;
  repairedTail: boolean;
  gaps: number[];
}

export interface SnapshotInfo {
  snapshot: string;
  sealedSeq: number;
  dbSeq: number;
}

export interface TruncateInfo {
  removed: number;
  kept: number;
  sealedSeq: number;
}

export interface Kernel {
  deviceId: string;
  dbPath: string;
  logPath: string;
  append(args: AppendArgs): Promise<LogEvent>;
  query<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  undo(eventId: string, actor?: string): Promise<LogEvent>;
  /** Settle an IOU: 'settled' needs online ack; failed/expired record locally. */
  settle(eventId: string, outcome: 'settled' | 'failed' | 'expired', actor?: string): Promise<LogEvent>;
  /** Sync via one relay, or fail over across a list in order (sticks to first healthy). */
  sync(relay: Relay | Relay[], opts?: SyncOpts): Promise<PushResult & PullResult & { pushRelay?: number; pullRelay?: number }>;
  /** Mint a relay capability token for this kernel's deviceId with a device private key. */
  capToken(privateKeyPem: string, scopes?: string[], ttlMs?: number): CapToken;
  conflicts(): Promise<Record<string, unknown>[]>;
  ackSeq(): number;
  serverTime(): number | null;
  verifyLog(): { ok: boolean; at?: number; reason?: string; gaps?: number[] };
  health(): LogHealth;
  /** Online full copy of the db + seal the acked prefix into it. */
  snapshot(dest?: string): Promise<SnapshotInfo>;
  /** Sweep the sealed prefix from the log (atomic file cutover). No-op when unsealed. */
  truncate(): Promise<TruncateInfo>;
  close(): void;
}
export function logPathFor(file: string): string {
  return file.replace(/\.(db|sqlite|sqlite3)$/, '') + '.log';
}

function toAppendInput(args: AppendArgs, deviceId: string, clock: () => number): AppendInput {
  const { type, actor, payload, ...rest } = args as {
    type: string;
    actor?: string;
    payload?: Record<string, unknown>;
  } & Record<string, unknown>;
  if (!type) throw new Error('append: type is required');
  // Shorthand (README): append({type:'bayar', nominal, oleh}) → payload.
  // Explicit: append({type, payload}) — extra keys merge under payload.
  const { device_id: _d, id: _i, ts_device: _t, ...clean } = rest;
  void _d;
  void _i;
  void _t;
  return { type, actor, device_id: deviceId, ts_device: clock(), payload: { ...clean, ...(payload ?? {}) } };
}

export async function createKernel(opts: KernelOpts): Promise<Kernel> {
  const dbPath = opts.file;
  const logPath = logPathFor(opts.file);
  const store: EventStore = openStore(dbPath);
  const deviceId: string = opts.deviceId ?? store.getMeta('device.id') ?? randomUUID();
  if (!store.getMeta('device.id')) store.setMeta('device.id', deviceId);
  const signer = opts.privateKeyPem ? (ev: LogEvent) => signEvent(opts.privateKeyPem as string, ev) : undefined;
  let log: AppendLog = openLog(logPath, deviceId, signer);
  // Crash recovery: replay the log into the read-model (idempotent by UUID),
  // then excise rows the log no longer carries (quarantined, never swept).
  store.replay(log.readAll());
  store.exciseMissing(
    log.readAll().map((e) => e.seq),
    log.sealedBelow,
  );

  const clock = opts.clock ?? Date.now;
  const maxPending = opts.maxPending ?? DEFAULT_OUTBOX_CAP;
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new Error(`maxPending must be a positive integer, got ${opts.maxPending}`);
  }
  // Failover memory across sync calls: failed relays cool down with backoff,
  // then get re-probed; list order decides fail-back.
  const failover: FailoverState = createFailoverState(0);
  async function append(args: AppendArgs): Promise<LogEvent> {
    const input = toAppendInput(args, deviceId, clock);
    checkAppend(input.type, input.payload ?? {}); // fail fast: no poison lines in the log
    const pending = log.maxSeq() - getAckSeq(store);
    if (pending >= maxPending) {
      throw new Error(
        `ERR_OUTBOX_FULL: outbox holds ${pending} pending events (cap ${maxPending}); ` +
          `oldest unsynced seq is ${getAckSeq(store) + 1}; sync to drain before appending`,
      );
    }
    const ev = log.append(input);
    store.apply(ev);
    return ev;
  }

  const kernel: Kernel = {
    deviceId,
    dbPath,
    logPath,
    append: (args) => append(args),
    query: <T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]> =>
      Promise.resolve(store.query<T>(sql, params)),
    undo: (eventId, actor) => append({ type: 'undo.compensate', payload: { reverses: eventId }, actor }),
    settle: (eventId, outcome, actor) => {
      const type = outcome === 'settled' ? 'payment.settled' : outcome === 'failed' ? 'payment.failed' : 'payment.expired';
      return append({ type, payload: { event_id: eventId }, actor });
    },
    sync: (relay, syncOpts) => {
      const relays = Array.isArray(relay) ? relay : [relay];
      if (
        relays.length === 0 ||
        relays.some((r) => !r || typeof (r as Relay).push !== 'function' || typeof (r as Relay).pull !== 'function')
      ) {
        throw new Error('sync needs a Relay object (push/pull) — raw URLs carry no transport in v0.1');
      }
      if (!Array.isArray(relay)) return runSync(log, store, relay as Relay, deviceId, syncOpts);
      return syncWithFailover(log, store, relays as Relay[], deviceId, syncOpts, failover);
    },
    capToken: (privateKeyPem, scopes = ['relay:push', 'relay:pull'], ttlMs = 3600 * 1000) =>
      mintCapToken(privateKeyPem, deviceId, scopes, ttlMs),
    conflicts: () => Promise.resolve(store.query(`SELECT * FROM conflicts WHERE status = 'open'`)),
    ackSeq: () => getAckSeq(store),
    serverTime: () => getServerTime(store),
    verifyLog: () => log.verify(),
    health: () => {
      const v = log.verify();
      return { events: log.readAll().length, quarantined: log.quarantined, repairedTail: log.repairedTail, gaps: v.gaps ?? [] };
    },
    snapshot: (dest) => Promise.resolve(takeSnapshot(store, dbPath, getAckSeq(store), dest)),
    truncate: () =>
      Promise.resolve().then(() => {
        const sealed = Number(store.getMeta('snapshot.sealed_seq') ?? 0);
        if (sealed <= 0) return { removed: 0, kept: log.readAll().length, sealedSeq: 0 };
        // Belt and suspenders on top of ack-implies-stored: a stale seal or a
        // cursor that outran the read-model must shrink to the safely swept
        // prefix (or to a no-op) instead of deleting unacked/unapplied data.
        const effective = clampSealToStored(
          store,
          log.readAll().map((e) => e.seq),
          sealed,
          getAckSeq(store),
        );
        if (effective <= 0) return { removed: 0, kept: log.readAll().length, sealedSeq: 0 };
        log.close();
        const res = sweepLogFile(logPath, effective);
        log = openLog(logPath, deviceId, signer);
        store.replay(log.readAll()); // incremental: kept suffix re-applies, db stands
        store.exciseMissing(
          log.readAll().map((e) => e.seq),
          log.sealedBelow,
        );
        return res;
      }),
    close: () => {
      log.close();
      store.close();
    },
  };
  return kernel;
}
