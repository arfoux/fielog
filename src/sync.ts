// sync.ts — delta push/pull by seq with server ack cursor.
// Idempotent by UUID, resumable in chunks, exponential backoff.
// The relay is dumb: accept raw log, broadcast, store. No business logic.
import type { AppendLog, LogEvent } from './log.js';
import type { EventStore } from './store.js';

export interface PushAck {
  acked: string[]; // event UUIDs accepted
  server_time: number; // authoritative time, stored on ack
}

export interface Relay {
  push(batch: LogEvent[]): Promise<PushAck>;
  pull(sinceRelaySeq: number): Promise<{ events: LogEvent[]; cursor: number }>;
}

export interface SyncOpts {
  chunkSize?: number;
  maxRetries?: number;
  baseMs?: number;
}

const ACK_SEQ_KEY = 'sync.ack_seq'; // local seq fully acked by the relay
const PULL_CURSOR_KEY = 'sync.pull_cursor'; // relay seq consumed via pull
const SERVER_TIME_KEY = 'sync.server_time'; // last authoritative server_time

export function getAckSeq(store: EventStore): number {
  return Number(store.getMeta(ACK_SEQ_KEY) ?? 0);
}

export function getServerTime(store: EventStore): number | null {
  const v = store.getMeta(SERVER_TIME_KEY);
  return v === null ? null : Number(v);
}

/** Backoff with jitter: baseMs * 2^attempt, capped at 30s. */
export function backoffMs(attempt: number, baseMs = 200): number {
  return Math.min(30_000, baseMs * 2 ** attempt) + Math.floor(Math.random() * 100);
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: SyncOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseMs = opts.baseMs ?? 200;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(attempt, baseMs)));
      attempt += 1;
    }
  }
}

export interface PushResult {
  pushed: number;
  acked: number;
  serverTime: number | null;
}

/** Push pending events (seq > ack cursor) in chunks; cursor persists per chunk. */
export async function pushPending(
  log: AppendLog,
  store: EventStore,
  relay: Relay,
  opts: SyncOpts = {},
): Promise<PushResult> {
  const chunkSize = opts.chunkSize ?? 10;
  let cursor = getAckSeq(store);
  let pushed = 0;
  let acked = 0;
  let serverTime: number | null = getServerTime(store);

  for (;;) {
    const batch = log.readAfter(cursor).slice(0, chunkSize);
    if (batch.length === 0) break;
    const ack = await withBackoff(() => relay.push(batch), opts);
    // Relay is idempotent by UUID: only advance over events it actually acked,
    // in log order, so a partial ack resumes exactly where it stopped.
    const ackedSet = new Set(ack.acked);
    let advanced = cursor;
    for (const ev of batch) {
      if (!ackedSet.has(ev.id)) break;
      advanced = ev.seq;
      acked += 1;
    }
    pushed += batch.length;
    serverTime = ack.server_time;
    store.setMeta(ACK_SEQ_KEY, String(advanced));
    store.setMeta(SERVER_TIME_KEY, String(ack.server_time));
    for (const ev of batch) {
      if (!ackedSet.has(ev.id)) continue;
      const local = store.getEventById(ev.id);
      if (local && local.server_time === undefined) {
        // Authoritative time only arrives via server ack — stamp it, never the clock.
        store.query(`UPDATE _events SET server_time = $t WHERE id = $id`, { t: ack.server_time, id: ev.id });
      }
    }
    cursor = advanced;
    if (advanced < batch[batch.length - 1].seq) break; // partial ack: stop, resume next run
  }
  return { pushed, acked, serverTime };
}

export interface PullResult {
  pulled: number;
  applied: number;
}

/** Pull remote events; apply idempotently by UUID under fresh local seq. */
export async function pullRemote(
  log: AppendLog,
  store: EventStore,
  relay: Relay,
  deviceId: string,
  opts: SyncOpts = {},
): Promise<PullResult> {
  const since = Number(store.getMeta(PULL_CURSOR_KEY) ?? 0);
  const { events, cursor } = await withBackoff(() => relay.pull(since), opts);
  let applied = 0;
  for (const remote of events) {
    if (store.hasId(remote.id)) continue; // idempotent by UUID
    const ev = log.append({
      type: remote.type,
      payload: remote.payload,
      actor: remote.actor,
      device_id: deviceId,
      id: remote.id,
      origin_seq: remote.seq,
      origin_device: remote.device_id,
    });
    store.apply(ev);
    applied += 1;
  }
  if (events.length) store.setMeta(PULL_CURSOR_KEY, String(cursor));
  return { pulled: events.length, applied };
}

export async function syncKernel(
  log: AppendLog,
  store: EventStore,
  relay: Relay,
  deviceId: string,
  opts: SyncOpts = {},
): Promise<PushResult & PullResult> {
  const push = await pushPending(log, store, relay, opts);
  const pull = await pullRemote(log, store, relay, deviceId, opts);
  return { ...push, ...pull };
}

// In-memory relay for tests and local dev. Replaceable in ~50 lines.
export class MemoryRelay implements Relay {
  private byId = new Map<string, LogEvent>();
  private order: LogEvent[] = [];
  serverTime: number;
  /** Fail the next N pushes (transient outage). */
  failPushes = 0;
  /** Fail a push after accepting the first N events of the batch (mid-batch cut). */
  failAfterEvents: number | null = null;
  pushesReceived = 0;

  constructor(serverTime = 1_700_000_000_000) {
    this.serverTime = serverTime;
  }

  get size(): number {
    return this.byId.size;
  }

  async push(batch: LogEvent[]): Promise<PushAck> {
    this.pushesReceived += 1;
    if (this.failPushes > 0) {
      this.failPushes -= 1;
      throw new Error('relay unavailable (injected failure)');
    }
    if (this.failAfterEvents !== null && this.failAfterEvents <= 0) {
      throw new Error('relay cut mid-batch (injected failure)');
    }
    const acked: string[] = [];
    for (const ev of batch) {
      if (this.failAfterEvents !== null) {
        if (this.failAfterEvents <= 0) break; // connection dropped: rest unacked
        this.failAfterEvents -= 1;
      }
      if (!this.byId.has(ev.id)) {
        this.byId.set(ev.id, ev);
        this.order.push(ev);
      }
      acked.push(ev.id); // idempotent: re-push of a known UUID still acks
    }
    if (this.failAfterEvents !== null && acked.length < batch.length) {
      // Persist what arrived, then report the cut so the client resumes.
      throw new Error(`relay cut mid-batch after ${acked.length}/${batch.length}`);
    }
    this.serverTime += 1; // HLC-ish tick: server time moves on every ack
    return { acked, server_time: this.serverTime };
  }

  async pull(sinceRelaySeq: number): Promise<{ events: LogEvent[]; cursor: number }> {
    const events = this.order.slice(sinceRelaySeq);
    // Positional cursor: the relay only promises an ordered, replayable log.
    return { events: [...events], cursor: this.order.length };
  }
}
