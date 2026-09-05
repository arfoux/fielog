// kernel.ts — createKernel({file}): append/query/undo/sync.
// Local-first: append/query/undo NEVER touch the network. Sync is background
// delta handled by sync.ts against a Relay object.
import { randomUUID } from 'node:crypto';
import { openLog, type AppendLog, type AppendInput, type LogEvent } from './log.js';
import { checkAppend, openStore, type EventStore, type SqlParams } from './store.js';
import {
  getAckSeq,
  getServerTime,
  syncKernel as runSync,
  type PushResult,
  type PullResult,
  type Relay,
  type SyncOpts,
} from './sync.js';

export interface KernelOpts {
  file: string; // e.g. 'kasir.db' (+ sidecar 'kasir.log')
  deviceId?: string;
  /** Wall-clock source for ts_device (display only, never order). Test seam for skew. */
  clock?: () => number;
}

export type AppendArgs =
  | { type: string; payload: Record<string, unknown>; actor?: string }
  | ({ type: string; actor?: string } & Record<string, unknown>);

export interface LogHealth {
  events: number;
  quarantined: number;
  repairedTail: boolean;
  gaps: number[];
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
  sync(relay: Relay, opts?: SyncOpts): Promise<PushResult & PullResult>;
  conflicts(): Promise<Record<string, unknown>[]>;
  ackSeq(): number;
  serverTime(): number | null;
  verifyLog(): { ok: boolean; at?: number; reason?: string; gaps?: number[] };
  health(): LogHealth;
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
  const log: AppendLog = openLog(logPath, deviceId);

  // Crash recovery: replay the log into the read-model (idempotent by UUID).
  store.replay(log.readAll());

  const clock = opts.clock ?? Date.now;
  async function append(args: AppendArgs): Promise<LogEvent> {
    const input = toAppendInput(args, deviceId, clock);
    checkAppend(input.type, input.payload ?? {}); // fail fast: no poison lines in the log
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
      if (typeof relay === 'string' || !relay || typeof (relay as Relay).push !== 'function') {
        throw new Error('sync needs a Relay object (push/pull) — raw URLs carry no transport in v0.1');
      }
      return runSync(log, store, relay as Relay, deviceId, syncOpts);
    },
    conflicts: () => Promise.resolve(store.query(`SELECT * FROM conflicts WHERE status = 'open'`)),
    ackSeq: () => getAckSeq(store),
    serverTime: () => getServerTime(store),
    verifyLog: () => log.verify(),
    health: () => {
      const v = log.verify();
      return { events: log.readAll().length, quarantined: log.quarantined, repairedTail: log.repairedTail, gaps: v.gaps ?? [] };
    },
    close: () => {
      log.close();
      store.close();
    },
  };
  return kernel;
}
