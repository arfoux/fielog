# kernel-api

Kernel, log, and store API reference. Signatures match `src/` exactly.

## `createKernel(opts)` (`src/kernel.ts`)

```ts
interface KernelOpts {
  file: string;              // 'kasir.db' (+ sidecar 'kasir.log' via logPathFor)
  deviceId?: string;
  clock?: () => number;      // ts_device source (display only). Test skew seam
  maxPending?: number;       // outbox cap, default 50_000 (DEFAULT_OUTBOX_CAP)
  privateKeyPem?: string;    // every local append is signed at the source
}
createKernel(opts: KernelOpts): Promise<Kernel>;
logPathFor(file: string): string; // 'kasir.db' -> 'kasir.log'
```

## `Kernel` (`src/kernel.ts:60-83`)

| method | signature | guarantee |
|---|---|---|
| append | `append(args: AppendArgs): Promise<LogEvent>` | writes log + fsync, no network. `AppendArgs = { type, payload } \| { type, ...fields, actor? }`. `bayar` needs a positive integer `nominal`; state only `DRAFT`/`IOU_RECORDED` |
| query | `query<T>(sql: string, params?: SqlParams): Promise<T[]>` | reads local SQLite, no network. Named params may be bare (`{id}` becomes `$id`) |
| undo | `undo(eventId: string, actor?: string): Promise<LogEvent>` | compensation event `undo.compensate`; history is never deleted; blind (the target may not have arrived — see [contracts](contracts.md)) |
| settle | `settle(eventId: string, 'settled' \| 'failed' \| 'expired', actor?: string): Promise<LogEvent>` | `payment.settled` / `payment.failed` / `payment.expired` |
| sync | `sync(relay: Relay \| Relay[], opts?: SyncOpts): Promise<PushResult & PullResult & { pushRelay?, pullRelay? }>` | one relay or ordered failover; raw URLs are rejected (needs a `Relay` object with `push`/`pull`) |
| capToken | `capToken(privateKeyPem: string, scopes? = ['relay:push','relay:pull'], ttlMs? = CAP_TOKEN_TTL_MS): CapToken` | mints this device's capability token |
| conflicts | `conflicts(): Promise<Record<string, unknown>[]>` | rows `conflicts WHERE status = 'open'` for human reconciliation |
| ackSeq | `ackSeq(): number` | local seq already acked by the relay |
| serverTime | `serverTime(): number \| null` | latest authoritative `server_time` |
| verifyLog | `verifyLog(): { ok, at?, reason?, gaps? }` | hash-chain verification |
| health | `health(): { events, quarantined, repairedTail, gaps }` | log health: corrupt lines, torn tail, gaps |
| snapshot | `snapshot(dest?: string): Promise<SnapshotInfo>` | full db copy + acked-prefix seal |
| truncate | `truncate(): Promise<TruncateInfo>` | sweeps the sealed prefix; no-op when unsealed |
| close | `close(): void` | closes the log fd + db |
| fields | `deviceId, dbPath, logPath: string` | identity + paths |

## `LogEvent` / `AppendLog` (`src/log.ts`)

```ts
interface LogEvent { id, seq, type, actor?, device_id, ts_device, payload,
  prev_hash, hash, origin_seq?, origin_device?, server_time?,
  signature?, countersignatures? }
interface AppendLog {
  path: string; append(input: AppendInput): LogEvent; readAll(): LogEvent[];
  readAfter(seq: number): LogEvent[]; hasId(id: string): boolean;
  getById(id: string): LogEvent | null; maxSeq(): number; lastHash(): string;
  verify(): VerifyResult; repairedTail: boolean; quarantined: number;
  sealedBelow: number; close(): void;
}
```

Pure functions: `hashFor(e)`, `canonicalOf(e)` (key-sorted canonical form,
`server_time` deliberately outside the hash), `GENESIS_HASH = 'GENESIS'`.

## `EventStore` (`src/store.ts:155-172`)

```ts
interface EventStore {
  apply(ev: LogEvent): void; replay(events: LogEvent[]): ReplayResult;
  exciseMissing(kept: number[], forgiveBelow: number): number;
  query<T>(sql: string, params?: SqlParams): T[];
  exec(sql: string): void; getEventById(id: string): LogEvent | null;
  hasId(id: string): boolean; getMeta(k: string): string | null;
  setMeta(k: string, v: string): void; close(): void;
}
checkAppend(type: string, payload: Record<string, unknown>): void; // fail-fast before the log is touched
MoneyState = { DRAFT, IOU_RECORDED, SETTLED_ONLINE, FAILED, EXPIRED };
```

Read schema (`bayar`, `stock`, `stock_moves`, `records`, `conflicts`,
`_events`, `_meta`, `_quarantine`): `src/store.ts:SCHEMA`.
Honest money: offline = IOU; `SETTLED_ONLINE` only via settle/sync ack.

Neighboring modules: [sync-protocol](sync-protocol.md),
[retention](retention.md), [auth](auth.md).
