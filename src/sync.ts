// sync.ts — delta push/pull by seq with server ack cursor.
// Idempotent by UUID, resumable in chunks, exponential backoff.
// The relay is dumb: accept raw log, broadcast, store. No business logic.
import type { AppendLog, LogEvent } from './log.js';
import { checkAppend, type EventStore } from './store.js';
import { checkThreshold, verifyEvent, type Countersignature } from './auth.js';

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
  maxMs?: number; // backoff cap; chaos tests pin this low
  /** deviceId -> ed25519 publicKeyPem. When non-empty, pull verifies every
   * remote event signature and dead-letters forgeries (cursor still advances). */
  trustedDevices?: Map<string, string> | Record<string, string>;
  /** High-value bayar gate: nominal >= limit needs threshold countersignatures. */
  highValue?: { limit: number; threshold: number };
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

/** Backoff with jitter: baseMs * 2^attempt, capped at maxMs. */
export function backoffMs(attempt: number, baseMs = 200, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** attempt) + Math.floor(Math.random() * 100);
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: SyncOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 30_000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(attempt, baseMs, maxMs)));
      attempt += 1;
    }
  }
}

/** Per-chunk ack handling shared by pushPending and failover push. */
function applyPushAck(
  store: EventStore,
  batch: LogEvent[],
  ack: PushAck,
  cursor: number,
): { advanced: number; acked: number } {
  // Relay is idempotent by UUID: only advance over events it actually acked,
  // in log order, so a partial ack resumes exactly where it stopped. Ack must
  // additionally imply durable store: a kill between log.append and
  // store.apply leaves the event on disk but out of the read-model, and
  // acking it would let truncate sweep it into permanent loss. Re-drive the
  // logged event first; if it still is not stored, hold the cursor here.
  const ackedSet = new Set(ack.acked);
  let advanced = cursor;
  let acked = 0;
  for (const ev of batch) {
    if (!ackedSet.has(ev.id)) break;
    if (!store.hasId(ev.id)) {
      try {
        store.apply(ev);
      } catch {
        break;
      }
      if (!store.hasId(ev.id)) break;
    }
    advanced = ev.seq;
    acked += 1;
  }
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
  return { advanced, acked };
}

/** Per-chunk pull handling shared by pullRemote and failover pull. */
function registryOf(opt: SyncOpts['trustedDevices']): Map<string, string> | null {
  if (!opt) return null;
  const m = opt instanceof Map ? opt : new Map(Object.entries(opt));
  return m.size > 0 ? m : null;
}

/** Forgery gate: verify the origin device signature (+ countersign threshold
 * for high-value bayar). False = dead-letter, never re-hashed clean. */
function verifyPullAuth(remote: LogEvent, registry: Map<string, string> | null, highValue?: { limit: number; threshold: number }): boolean {
  if (!registry) return true; // no registry: unsigned legacy path stays valid
  const origin = remote.device_id;
  const pub = typeof origin === 'string' ? registry.get(origin) : undefined;
  if (!pub) return false; // unknown origin device: cannot authenticate
  if (typeof remote.signature !== 'string' || remote.signature === '') return false;
  if (!verifyEvent(pub, remote, remote.signature)) return false;
  if (highValue && remote.type === 'bayar') {
    const nominal = Number((remote.payload as Record<string, unknown>)?.['nominal']);
    if (Number.isFinite(nominal) && nominal >= highValue.limit) {
      const sigs = (remote.countersignatures ?? []) as Countersignature[];
      if (!checkThreshold(registry, remote, sigs, highValue.threshold).thresholdMet) return false;
    }
  }
  return true;
}

function applyPullEvents(
  log: AppendLog,
  store: EventStore,
  deviceId: string,
  events: LogEvent[],
  cursor: number,
  opts: SyncOpts = {},
): number {
  const registry = registryOf(opts.trustedDevices);
  let applied = 0;
  let storedAll = true;
  for (const remote of events) {
    // Fail-fast gate (mirrors kernel append): a poison event must never
    // touch the local log nor pin the pull cursor. Shape + checkAppend run
    // BEFORE log.append; dead-letters are skipped while the cursor below
    // still advances past them, so one bad write can never brick sync.
    if (!remote || typeof remote.id !== 'string' || remote.id === '') continue;
    if (store.hasId(remote.id)) continue;
    if (log.hasId(remote.id)) {
      // Logged on an earlier run but never durably stored (kill between
      // log.append and store.apply, or a held cursor below). Re-drive the
      // stored copy instead of minting a duplicate log line; a repeated
      // failure holds the cursor so the next sync retries this batch.
      const pending = log.getById(remote.id);
      if (pending === null) {
        storedAll = false;
        continue;
      }
      try {
        store.apply(pending);
      } catch {
        storedAll = false;
        continue;
      }
      applied += 1;
      continue;
    }
    try {
      if (!remote.type || typeof remote.type !== 'string') throw new Error('pull: event without type');
      const payload = (remote.payload ?? {}) as Record<string, unknown>;
      if (typeof payload !== 'object' || payload === null) throw new Error('pull: payload must be an object');
      checkAppend(remote.type, payload);
    } catch {
      continue;
    }
    // Forgery laundering gate: the relay stores verbatim (dumb by design),
    // so anyone can stash a "bayar 1000000 as budi". Verify the ORIGIN hash
    // before the local re-hash below mints a clean copy. Forged events are
    // dead-lettered (skipped, cursor still advances past them).
    if (!verifyPullAuth(remote, registry, opts.highValue)) continue;
    const ev = log.append({
      type: remote.type,
      payload: (remote.payload ?? {}) as Record<string, unknown>,
      actor: remote.actor,
      device_id: deviceId,
      id: remote.id,
      ts_device: remote.ts_device, // origin stamp kept as display metadata; order stays local
      origin_seq: remote.seq,
      origin_device: remote.device_id,
    });
    try {
      store.apply(ev);
    } catch {
      // Sqlite-level failure with the event already fsynced in the log:
      // hold the pull cursor so the retry above re-drives it instead of
      // abandoning it past the cursor (truncate would then lose it).
      storedAll = false;
      continue;
    }
    applied += 1;
  }
  if (events.length && storedAll) store.setMeta(PULL_CURSOR_KEY, String(cursor));
  return applied;
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
    const { advanced, acked: n } = applyPushAck(store, batch, ack, cursor);
    acked += n;
    pushed += batch.length;
    serverTime = ack.server_time;
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
  const applied = applyPullEvents(log, store, deviceId, events, cursor, opts);
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
// Relay failover: try relays in list order per chunk, stick to the first
// healthy one, park failures on backoff and re-probe them later. A chunk is
// always served by exactly one relay; cursors stay per-chunk so resume is
// exact-once by UUID like the single-relay path.
export interface FailoverState {
  fails: number[];
  notBefore: number[];
}

export function createFailoverState(n: number): FailoverState {
  return { fails: Array(n).fill(0), notBefore: Array(n).fill(0) };
}

export interface FailoverResult extends PushResult, PullResult {
  /** Index of the relay that served the last push chunk (-1 when nothing pushed). */
  pushRelay: number;
  /** Index of the relay that served the pull (-1 when pull never succeeded). */
  pullRelay: number;
}

function failoverNoteFailure(state: FailoverState, i: number, opts: SyncOpts): void {
  state.fails[i] += 1;
  state.notBefore[i] = Date.now() + backoffMs(state.fails[i] - 1, opts.baseMs ?? 200, opts.maxMs ?? 30_000);
}

/** List order first, relays still on backoff last (re-probed once cooled down). */
function failoverOrder(n: number, state: FailoverState, now: number): number[] {
  const fresh: number[] = [];
  const cooling: number[] = [];
  for (let i = 0; i < n; i++) (now < state.notBefore[i] ? cooling : fresh).push(i);
  return [...fresh, ...cooling];
}

async function failoverPushOne(
  log: AppendLog,
  store: EventStore,
  relays: Relay[],
  batch: LogEvent[],
  cursor: number,
  opts: SyncOpts,
  state: FailoverState,
): Promise<{ advanced: number; acked: number; serverTime: number; relay: number }> {
  const maxPasses = (opts.maxRetries ?? 5) + 1;
  let lastErr: unknown = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    let skipped = 0;
    for (const i of failoverOrder(relays.length, state, Date.now())) {
      if (Date.now() < state.notBefore[i]) {
        skipped += 1;
        continue;
      }
      try {
        const ack = await relays[i].push(batch);
        const { advanced, acked } = applyPushAck(store, batch, ack, cursor);
        state.fails[i] = 0;
        state.notBefore[i] = 0;
        return { advanced, acked, serverTime: ack.server_time, relay: i };
      } catch (err) {
        lastErr = err;
        failoverNoteFailure(state, i, opts);
      }
    }
    if (pass + 1 >= maxPasses) break;
    // All failed or still cooling: wait out the shortest backoff, then re-probe.
    const wait = skipped > 0
      ? Math.max(0, Math.min(...state.notBefore) - Date.now())
      : backoffMs(pass, opts.baseMs ?? 200, opts.maxMs ?? 30_000);
    if (wait > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`all ${relays.length} relays failed`);
}

export async function syncWithFailover(
  log: AppendLog,
  store: EventStore,
  relays: Relay[],
  deviceId: string,
  opts: SyncOpts = {},
  state?: FailoverState,
): Promise<FailoverResult> {
  if (relays.length === 0) throw new Error('sync needs at least one relay');
  const st = state ?? createFailoverState(relays.length);
  while (st.fails.length < relays.length) {
    st.fails.push(0);
    st.notBefore.push(0);
  }
  const chunkSize = opts.chunkSize ?? 10;
  let cursor = getAckSeq(store);
  let pushed = 0;
  let acked = 0;
  let serverTime: number | null = getServerTime(store);
  let pushRelay = -1;

  for (;;) {
    const batch = log.readAfter(cursor).slice(0, chunkSize);
    if (batch.length === 0) break;
    const one = await failoverPushOne(log, store, relays, batch, cursor, opts, st);
    pushed += batch.length;
    acked += one.acked;
    serverTime = one.serverTime;
    cursor = one.advanced;
    pushRelay = one.relay;
    if (one.advanced < batch[batch.length - 1].seq) break; // partial ack: stop, resume next run
  }

  // Pull from the first healthy relay in list order; own events echo back
  // but apply stays idempotent by UUID.
  const since = Number(store.getMeta(PULL_CURSOR_KEY) ?? 0);
  let pullRelay = -1;
  let pulled = 0;
  let applied = 0;
  const maxPasses = (opts.maxRetries ?? 5) + 1;
  let lastErr: unknown = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    let skipped = 0;
    let done = false;
    for (const i of failoverOrder(relays.length, st, Date.now())) {
      if (Date.now() < st.notBefore[i]) {
        skipped += 1;
        continue;
      }
      try {
        const res = await relays[i].pull(since);
        applied = applyPullEvents(log, store, deviceId, res.events, res.cursor, opts);
        pulled = res.events.length;
        pullRelay = i;
        st.fails[i] = 0;
        st.notBefore[i] = 0;
        done = true;
        break;
      } catch (err) {
        lastErr = err;
        failoverNoteFailure(st, i, opts);
      }
    }
    if (done) break;
    if (pass + 1 >= maxPasses) break;
    const wait = skipped > 0
      ? Math.max(0, Math.min(...st.notBefore) - Date.now())
      : backoffMs(pass, opts.baseMs ?? 200, opts.maxMs ?? 30_000);
    if (wait > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
    }
  }
  if (pullRelay < 0) throw lastErr instanceof Error ? lastErr : new Error(`all ${relays.length} relays failed`);
  return { pushed, acked, serverTime, pulled, applied, pushRelay, pullRelay };
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
