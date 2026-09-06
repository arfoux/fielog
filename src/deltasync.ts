// deltasync.ts — manifest-first delta sync between two fielog replicas.
//
// Protocol (boring, in order):
//   1. manifest: receiver pulls sender manifest { count, tip, ids[] } first.
//   2. want-list: receiver diffs sender ids against its local UUID set.
//   3. fetch: receiver fetches only the want-list, in chunks, in manifest order.
//   4. apply: each fetched event appends under a fresh local seq, idempotent by UUID.
//   5. resume: want-list progress persists per chunk in store meta; a cut
//      re-runs from the persisted remainder (plus any new manifest ids).
//
// Transport is a DeltaPeer { manifest, fetch } — memory, file, or ws backed.
// Trust note: peers here are trusted replicas (same operator). Forgery-gated
// pull with a device registry stays on the sync.ts path (pullRemote); this
// file does shape validation (checkAppend) but no signature verification.
import { checkAppend, type EventStore } from './store.js';
import { withBackoff } from './sync.js';
import type { AppendLog, LogEvent } from './log.js';

export interface DeltaManifest {
  v: 1;
  /** sender event count at manifest time. */
  count: number;
  /** sender tip hash at manifest time (change hint, not verified here). */
  tip: string;
  /** sender UUIDs in log order. */
  ids: string[];
}

/** Minimal delta transport: manifest first, then fetch by UUID. */
export interface DeltaPeer {
  manifest(): Promise<DeltaManifest>;
  /** Return events for the requested UUIDs, in request order when possible. */
  fetch(ids: string[]): Promise<LogEvent[]>;
}

export interface DeltaOpts {
  /** events fetched+applied per chunk; cursor persists per chunk. */
  chunkSize?: number;
  /** store-meta namespace for persisted resume state (default 'deltasync'). */
  cursorKey?: string;
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
}

export interface DeltaResult {
  /** UUIDs missing locally at plan time (before this run's applies). */
  wanted: number;
  /** events fetched from the peer this run. */
  fetched: number;
  /** events newly applied to the local log+store this run. */
  applied: number;
  /** true when this run continued persisted want-list progress. */
  resumed: boolean;
  /** true when nothing remains (local has every manifest id). */
  done: boolean;
}

/** Build the sender-side manifest over log order. */
export function buildManifest(log: AppendLog): DeltaManifest {
  const ids = log.readAll().map((e) => e.id);
  return { v: 1, count: ids.length, tip: log.lastHash(), ids };
}

/** Receiver-side diff: sender ids missing from the local UUID set, in sender order. */
export function computeWant(localIds: Set<string>, remote: DeltaManifest): string[] {
  const want: string[] = [];
  for (const id of remote.ids) {
    if (typeof id === 'string' && id !== '' && !localIds.has(id)) want.push(id);
  }
  return want;
}

/** In-memory peer over an AppendLog (tests, local dev). */
export function createMemoryPeer(log: AppendLog): DeltaPeer {
  return {
    async manifest(): Promise<DeltaManifest> {
      return buildManifest(log);
    },
    async fetch(ids: string[]): Promise<LogEvent[]> {
      const out: LogEvent[] = [];
      for (const id of ids) {
        const ev = log.getById(id);
        if (ev !== null) out.push(ev);
      }
      return out;
    },
  };
}

function localIdSet(log: AppendLog): Set<string> {
  const ids = new Set<string>();
  for (const e of log.readAll()) ids.add(e.id);
  return ids;
}

function loadPersistedWant(store: EventStore, cursorKey: string): string[] {
  const raw = store.getMeta(`${cursorKey}.want`);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x !== '');
  } catch {
    return [];
  }
}

function savePersistedWant(store: EventStore, cursorKey: string, want: string[]): void {
  store.setMeta(`${cursorKey}.want`, JSON.stringify(want));
}
/** Merge persisted remainder with a fresh want-list; manifest order wins. */
function mergeWant(persisted: string[], fresh: string[], freshOrder: string[]): string[] {
  const freshSet = new Set(fresh);
  const order = new Map<string, number>(freshOrder.map((id, i) => [id, i]));
  const seen = new Set(persisted.filter((id) => freshSet.has(id)));
  const merged = [...seen];
  for (const id of fresh) {
    if (!seen.has(id)) {
      merged.push(id);
      seen.add(id);
    }
  }
  merged.sort((a, b) => (order.get(a) ?? 1e12) - (order.get(b) ?? 1e12));
  return merged;
}

/** Validate + append one remote event locally. */
type ApplyOutcome = 'applied' | 'duplicate' | 'poison' | 'retry';
function applyOneRemote(
  log: AppendLog,
  store: EventStore,
  deviceId: string,
  remote: LogEvent,
): ApplyOutcome {
  if (!remote || typeof remote.id !== 'string' || remote.id === '') return 'poison';
  // Idempotent by UUID: already stored -> no-op; logged but not stored
  // (kill between log.append and store.apply) -> re-drive the stored copy.
  if (store.hasId(remote.id)) return 'duplicate';
  if (log.hasId(remote.id)) {
    const pending = log.getById(remote.id);
    if (pending === null) return 'retry';
    try {
      store.apply(pending);
    } catch {
      return 'retry';
    }
    return store.hasId(remote.id) ? 'applied' : 'retry';
  }
  try {
    if (!remote.type || typeof remote.type !== 'string') return 'poison';
    const payload = (remote.payload ?? {}) as Record<string, unknown>;
    if (typeof payload !== 'object' || payload === null) return 'poison';
    checkAppend(remote.type, payload);
  } catch {
    return 'poison'; // poison shape: dead-letter, never pins the want-list
  }
  const ev = log.append({
    type: remote.type,
    payload: (remote.payload ?? {}) as Record<string, unknown>,
    actor: remote.actor,
    device_id: deviceId,
    id: remote.id,
    ts_device: remote.ts_device,
    origin_seq: remote.seq,
    origin_device: remote.device_id,
  });
  try {
    store.apply(ev);
  } catch {
    return 'retry'; // fsynced but not stored: hold the id so retry re-drives it
  }
  return 'applied';
}

/**
 * Manifest-first delta sync from a peer into this replica.
 * Resume: want-list remainder persists per chunk; re-call after a cut.
 */
export async function syncDelta(
  log: AppendLog,
  store: EventStore,
  deviceId: string,
  peer: DeltaPeer,
  opts: DeltaOpts = {},
): Promise<DeltaResult> {
  const chunkSize = opts.chunkSize ?? 50;
  const cursorKey = opts.cursorKey ?? 'deltasync';
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`syncDelta: chunkSize must be a positive integer, got ${opts.chunkSize}`);
  }
  const manifest = await withBackoff(() => peer.manifest(), opts);
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.ids)) {
    throw new Error('syncDelta: bad manifest (want { v: 1, ids: string[] })');
  }
  const persisted = loadPersistedWant(store, cursorKey);
  const fresh = computeWant(localIdSet(log), manifest);
  const persistedLive = persisted.filter((id) => !store.hasId(id) && !log.hasId(id));
  const want = persistedLive.length > 0 ? mergeWant(persistedLive, fresh, manifest.ids) : fresh;
  const resumed = persistedLive.length > 0;
  const wanted = want.length;
  if (want.length === 0) {
    savePersistedWant(store, cursorKey, []);
    return { wanted: 0, fetched: 0, applied: 0, resumed, done: true };
  }
  let fetched = 0;
  let applied = 0;
  let remainder = [...want];
  let idle = 0;
  // Persist the plan before fetching so a kill during chunk 1 still resumes.
  savePersistedWant(store, cursorKey, remainder);
  while (remainder.length > 0) {
    const chunk = remainder.slice(0, chunkSize);
    const events = await withBackoff(() => peer.fetch(chunk), opts);
    fetched += events.length;
    const appliedBefore = applied;
    const before = remainder.length;
    const byId = new Map(events.map((e) => [e?.id, e]));
    const hold: string[] = [];
    for (const id of chunk) {
      const remote = byId.get(id);
      if (!remote) {
        hold.push(id); // peer short: retry next run, keep cursor
        continue;
      }
      const outcome = applyOneRemote(log, store, deviceId, remote);
      if (outcome === 'applied') applied += 1;
      if (outcome === 'retry') hold.push(id);
    }
    remainder = [...hold, ...remainder.slice(chunkSize)];
    savePersistedWant(store, cursorKey, remainder);
    if (remainder.length >= before && applied === appliedBefore) {
      idle += 1;
      if (idle >= 2) return { wanted, fetched, applied, resumed, done: false };
    } else {
      idle = 0;
    }
  }
  return { wanted, fetched, applied, resumed, done: true };
}
