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
import { CAP_TOKEN_TTL_MS, mintCapToken, signEvent, type CapToken } from './auth.js';

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
  const storedDevice: string | null = store.getMeta('device.id');
  const storedExplicit: string | null = store.getMeta('device.explicit');
  if (storedDevice && opts.deviceId && storedDevice !== opts.deviceId && storedExplicit === '1') {
    const msg =
      `ERR_DEVICE_MISMATCH: explicit deviceId '${opts.deviceId}' != stored '${storedDevice}' for '${dbPath}'; ` +
      `refusing to split-brain (reopen with the stored id, or use a fresh file for a new device)`;
    store.close();
    throw new Error(msg);
  }
  const deviceId: string = opts.deviceId ?? storedDevice ?? randomUUID();
  if (!storedDevice) {
    store.setMeta('device.id', deviceId);
    store.setMeta('device.explicit', opts.deviceId ? '1' : '0');
  } else if (opts.deviceId && storedDevice !== opts.deviceId) {
    // First explicit open over an auto-generated id: adopt it (the common
    // init-then-sync flow), and mark it explicit so any later id throws.
    store.setMeta('device.id', deviceId);
    store.setMeta('device.explicit', '1');
  }
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
  // Append/truncate mutex: truncate closes and reopens the log fd, so an
  // append racing it could write into a closed fd or a stale generation.
  // Serialize both through one promise chain (cooperative: same process).
  let tail: Promise<void> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(fn);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /** Re-drive log lines the read-model never applied (kill between log.append
   * and store.apply), like the sync/deltasync pull path. Idempotent by UUID.
   * Gated on a suspect flag: a split can only appear when an append's
   * store.apply throws (flagged below) or across a restart (covered by the
   * open-time replay), so the steady path stays O(1) instead of O(log). */
  let splitSuspect = false;
  function healSplit(): void {
    if (!splitSuspect) return;
    splitSuspect = false;
    for (const e of log.readAll()) {
      if (store.hasId(e.id)) continue;
      try {
        store.apply(e);
      } catch {
        splitSuspect = true; // still failing: leave it for the next append or restart
      }
    }
  }
  async function appendInner(args: AppendArgs): Promise<LogEvent> {
    healSplit();
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
    // Contract: the log line above is already fsynced, so a store failure
    // here is a split, not a loss. Fail loud (never swallow) and let the
    // next append/restart re-drive the durable line via healSplit/replay.
    try {
      store.apply(ev);
    } catch (err) {
      splitSuspect = true; // the durable line above still needs re-driving
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ERR_APPLY_SPLIT: log seq ${ev.seq} (id ${ev.id}) is durable but the read-model apply failed (${why}); ` +
          `it will be re-driven on the next append or restart`,
      );
    }
    return ev;
  }
  const kernel: Kernel = {
    deviceId,
    dbPath,
    logPath,
    append: (args) => serialize(() => appendInner(args)),

    query: <T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]> =>
      Promise.resolve(store.query<T>(sql, params)),
    undo: async (eventId, actor) => {
      // Blind compensator by design: the target may live on a peer replica
      // not yet synced here. Convergence is by fold, not by local existence.
      return serialize(() => appendInner({ type: 'undo.compensate', payload: { reverses: eventId }, actor }));
    },
    settle: async (eventId, outcome, actor) => {
      const type = outcome === 'settled' ? 'payment.settled' : outcome === 'failed' ? 'payment.failed' : 'payment.expired';
      return serialize(() => appendInner({ type, payload: { event_id: eventId }, actor }));
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
    capToken: (privateKeyPem, scopes = ['relay:push', 'relay:pull'], ttlMs = CAP_TOKEN_TTL_MS) =>
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
      serialize(async () => {
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
        // The log fd must be closed for the sweep, so a failed sweep must
        // still reopen it: a closed-but-referenced log breaks every later
        // append with EBADF. finally keeps the kernel usable either way.
        log.close();
        try {
          return sweepLogFile(logPath, effective);
        } finally {
          log = openLog(logPath, deviceId, signer);
          store.replay(log.readAll()); // incremental: kept suffix re-applies, db stands
          store.exciseMissing(
            log.readAll().map((e) => e.seq),
            log.sealedBelow,
          );
        }
      }),
    close: () => {
      log.close();
      store.close();
    },
  };
  return kernel;
}
