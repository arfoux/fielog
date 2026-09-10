# sync-protocol

Delta push/pull per `seq` with ack cursors (`src/sync.ts`), plus
manifest-first sync between replicas (`src/deltasync.ts`, details
[delta-sync](delta-sync.md)).

## `Relay` + results (`src/sync.ts:8-16,506-543`)

```ts
interface Relay {
  push(batch: LogEvent[]): Promise<PushAck>;          // PushAck = { acked: string[], server_time: number }
  pull(sinceRelaySeq: number): Promise<{ events: LogEvent[], cursor: number }>;
}
interface PushResult { pushed: number; acked: number; serverTime: number | null }
interface PullResult { pulled: number; applied: number; quarantined: number }
```

| function | signature | guarantee |
|---|---|---|
| `pushPending` | `(log, store, relay, opts?): Promise<PushResult>` | pushes `seq > ack cursor` per chunk; cursor persists per chunk; halts on partial ack, resumes next run |
| `pullRemote` | `(log, store, relay, deviceId, opts?): Promise<PullResult>` | pulls, applies idempotently per UUID under the new local seq; forged/poison/co-revoked events enter quarantine, cursor still advances; retroactive revoke sweep on signal |
| `syncKernel` | `(log, store, relay, deviceId, opts?): Promise<PushResult & PullResult>` | push then pull |
| `syncWithFailover` | `(log, store, relays, deviceId, opts?, state?): Promise<FailoverResult>` | tries relays in list order per chunk, sticks to the first healthy one; failure = backoff cooldown + re-probe; list order decides fail-back |
| `withBackoff` | `(fn, opts?): Promise<T>` | exponential-backoff retry; stops on permanent errors (`isPermanentSyncError`: forbidden / bad cursor / capability / revok / unknown device / unauthorized) |
| `backoffMs` | `(attempt, baseMs = 200, maxMs = 30_000, jitter?): number` | `baseMs * 2^attempt` capped at `maxMs` + jitter. Default deterministic (`((attempt+1)*37) % 100`) |
| `createFailoverState` | `(n: number): FailoverState` | failover memory across kernel sync calls |
| `getAckSeq` / `getServerTime` | `(store): number` / `(store): number \| null` | local ack cursor (`sync.ack_seq`) / authoritative time (`sync.server_time`) |
| `MemoryRelay` | `class MemoryRelay implements Relay` | in-memory relay for local test/dev (~50 lines) |
| `purgeRevoked` | `(log, store, opts?): PurgeResult` | retroactively sweeps revoked events from the read view; log lines + `_events` stay (forensics). Incremental via the `sync.purge_seq` cursor + fingerprint |
| `getPurgeSeq` | `(store): number` | last swept seq |

## `SyncOpts` (`src/sync.ts:20-50`)

```ts
interface SyncOpts {
  chunkSize?: number; maxRetries?: number; baseMs?: number; maxMs?: number;
  trustedDevices?: Map<string,string> | Record<string,string>; // non-empty = verify every pulled event
  highValue?: { limit: number; threshold: number };             // entry >= limit needs threshold countersign
  revokedDevices?: Set<string> | string[]; isRevoked?: (ev: LogEvent) => boolean;
  revokeVersion?: string | number;                              // version stamp so the incremental sweep knows when to rescan
  jitter?: boolean | number | (() => number);                   // default false = deterministic
}
```

## deltasync (`src/deltasync.ts`)

```ts
interface DeltaPeer { manifest(): Promise<DeltaManifest>; fetch(ids: string[]): Promise<LogEvent[]> }
interface DeltaOpts { chunkSize?: number; cursorKey?: string; maxRetries?: number; baseMs?: number; maxMs?: number }
interface DeltaResult { wanted, fetched, applied, poisoned, resumed, done }
buildManifest(log): DeltaManifest; computeWant(localIds, remote): string[];
createMemoryPeer(log): DeltaPeer;
syncDelta(log, store, deviceId, peer, opts?): Promise<DeltaResult>;
```

Origin-auth-stripping contract: the receiver does NOT copy the sender's
`signature` / `countersignatures` / `seq` / `prev_hash` / `hash` — local
seq/hash/device are freshly minted, origin survives only as
`origin_seq`/`origin_device`. No signature verification here: a peer is a
trusted same-operator replica; pulls with a forgery registry still go through

> DO NOT MIX TRANSPORTS ON ONE REPLICA without expecting duplicate work
> and an auth downgrade. Three cursor namespaces never transfer
> progress: `sync.ack_seq` / shared `sync.pull_cursor` (single-relay
> pull, `src/sync.ts:53-55`) vs per-relay `sync.pull_cursor.r<i>`
> (failover, `src/sync.ts:734-735`) vs deltasync `<cursorKey>.want`
> (default `deltasync.want`, `src/deltasync.ts:232,248`). Worse,
> deltasync strips origin auth by design — receiver mints fresh local
> `seq`/`hash` and drops `signature`/`countersignatures`
> (`src/deltasync.ts`, see [delta-sync](delta-sync.md)) — so rows that
> arrived via deltasync and later push through a signed relay propagate
> as unsigned rows a verifying peer dead-letters. Pick one transport
> per replica pair; the forgery gate (`verifyPullAuth`) lives only on
> the `pullRemote` path.

The binding behavioral promises live in [contracts](contracts.md).
