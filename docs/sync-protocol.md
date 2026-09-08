# sync-protocol

Delta push/pull per `seq` dengan cursor ack (`src/sync.ts`), plus sync
manifest-first antar replika (`src/deltasync.ts`, pendalaman
[delta-sync](delta-sync.md)).

## `Relay` + hasil (`src/sync.ts:8-16,506-543`)

```ts
interface Relay {
  push(batch: LogEvent[]): Promise<PushAck>;          // PushAck = { acked: string[], server_time: number }
  pull(sinceRelaySeq: number): Promise<{ events: LogEvent[], cursor: number }>;
}
interface PushResult { pushed: number; acked: number; serverTime: number | null }
interface PullResult { pulled: number; applied: number; quarantined: number }
```

| fungsi | tanda tangan | janji |
|---|---|---|
| `pushPending` | `(log, store, relay, opts?): Promise<PushResult>` | dorong `seq > ack cursor` per chunk; cursor persist per chunk; berhenti di ack parsial, lanjut run berikut |
| `pullRemote` | `(log, store, deviceId, opts?): Promise<PullResult>` | tarik, terapkan idempoten per UUID di bawah seq lokal baru; pemalsu/poison/co-revoke masuk karantina, cursor tetap maju; sapu retroaktif revoke bila ada sinyal |
| `syncKernel` | `(log, store, relay, deviceId, opts?): Promise<PushResult & PullResult>` | push lalu pull |
| `syncWithFailover` | `(log, store, relays, deviceId, opts?, state?): Promise<FailoverResult>` | coba relay sesuai urutan list per chunk, stick ke yang sehat pertama; gagal = cooldown backoff + re-probe; urutan list menentukan fail-back |
| `withBackoff` | `(fn, opts?): Promise<T>` | retry backoff eksponensial; berhenti untuk error permanen (`isPermanentSyncError`: forbidden / bad cursor / capability / revok / unknown device / unauthorized) |
| `backoffMs` | `(attempt, baseMs = 200, maxMs = 30_000, jitter?): number` | `baseMs * 2^attempt` cap `maxMs` + jitter. Default deterministik (`((attempt+1)*37) % 100`) |
| `createFailoverState` | `(n: number): FailoverState` | memori failover antar panggilan sync kernel |
| `getAckSeq` / `getServerTime` | `(store): number` / `(store): number \| null` | cursor ack lokal (`sync.ack_seq`) / waktu otoritatif (`sync.server_time`) |
| `MemoryRelay` | `class MemoryRelay implements Relay` | relay in-memory untuk test/dev lokal (~50 baris) |
| `purgeRevoked` | `(log, store, opts?): PurgeResult` | sapu retroaktif event terevoke dari view baca; baris log + `_events` tetap (forensik). Inkremental via cursor `sync.purge_seq` + fingerprint |
| `getPurgeSeq` | `(store): number` | seq terakhir yang disapu |

## `SyncOpts` (`src/sync.ts:20-50`)

```ts
interface SyncOpts {
  chunkSize?: number; maxRetries?: number; baseMs?: number; maxMs?: number;
  trustedDevices?: Map<string,string> | Record<string,string>; // non-kosong = verifikasi tiap event pull
  highValue?: { limit: number; threshold: number };             // bayar >= limit butuh threshold countersign
  revokedDevices?: Set<string> | string[]; isRevoked?: (ev: LogEvent) => boolean;
  revokeVersion?: string | number;                              // stempel versi agar sweep inkremental tahu kapan rescan
  jitter?: boolean | number | (() => number);                   // default false = deterministik
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

Kontrak stripping auth asal: receiver TIDAK menyalin `signature` /
`countersignatures` / `seq` / `prev_hash` / `hash` pengirim — seq/hash/device
lokal dicetak baru, asal bertahan hanya sebagai `origin_seq`/`origin_device`.
Tanpa verifikasi tanda di sini: peer = replika tepercaya satu operator;
pull dengan registry pemalsu tetap di jalur `pullRemote`.

Janji perilaku yang mengikat ada di [contracts](contracts.md).
