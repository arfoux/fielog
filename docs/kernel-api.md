# kernel-api

Referensi API kernel, log, dan store. Tanda tangan persis `src/`.

## `createKernel(opts)` (`src/kernel.ts`)

```ts
interface KernelOpts {
  file: string;              // 'kasir.db' (+ sidecar 'kasir.log' via logPathFor)
  deviceId?: string;
  clock?: () => number;      // sumber ts_device (display saja). Seam test skew
  maxPending?: number;       // cap outbox, default 50_000 (DEFAULT_OUTBOX_CAP)
  privateKeyPem?: string;    // tiap append lokal ditandatangani di sumber
}
createKernel(opts: KernelOpts): Promise<Kernel>;
logPathFor(file: string): string; // 'kasir.db' -> 'kasir.log'
```

## `Kernel` (`src/kernel.ts:60-83`)

| method | tanda tangan | janji |
|---|---|---|
| append | `append(args: AppendArgs): Promise<LogEvent>` | tulis log + fsync, tanpa jaringan. `AppendArgs = { type, payload } \| { type, ...isi, actor? }`. `bayar` butuh `nominal` integer positif; state hanya `DRAFT`/`IOU_RECORDED` |
| query | `query<T>(sql: string, params?: SqlParams): Promise<T[]>` | baca SQLite lokal, tanpa jaringan. Named param boleh polos (`{id}` jadi `$id`) |
| undo | `undo(eventId: string, actor?: string): Promise<LogEvent>` | event kompensasi `undo.compensate`; riwayat tidak dihapus; buta (target boleh belum tiba — lihat [contracts](contracts.md)) |
| settle | `settle(eventId: string, 'settled' \| 'failed' \| 'expired', actor?: string): Promise<LogEvent>` | `payment.settled` / `payment.failed` / `payment.expired` |
| sync | `sync(relay: Relay \| Relay[], opts?: SyncOpts): Promise<PushResult & PullResult & { pushRelay?, pullRelay? }>` | satu relay atau failover berurutan; URL mentah ditolak (butuh objek `Relay` dengan `push`/`pull`) |
| capToken | `capToken(privateKeyPem: string, scopes? = ['relay:push','relay:pull'], ttlMs? = CAP_TOKEN_TTL_MS): CapToken` | cetak token kapabilitas device ini |
| conflicts | `conflicts(): Promise<Record<string, unknown>[]>` | baris `conflicts WHERE status = 'open'` untuk rekonsiliasi manusia |
| ackSeq | `ackSeq(): number` | seq lokal yang sudah di-ack relay |
| serverTime | `serverTime(): number \| null` | `server_time` otoritatif terakhir |
| verifyLog | `verifyLog(): { ok, at?, reason?, gaps? }` | verifikasi rantai hash |
| health | `health(): { events, quarantined, repairedTail, gaps }` | kondisi log: baris korup, ekor robek, celah |
| snapshot | `snapshot(dest?: string): Promise<SnapshotInfo>` | salinan penuh db + seal prefix acked |
| truncate | `truncate(): Promise<TruncateInfo>` | sapu prefix tersegel; no-op bila belum disegel |
| close | `close(): void` | tutup fd log + db |
| lapang | `deviceId, dbPath, logPath: string` | identitas + path |

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

Fungsi murni: `hashFor(e)`, `canonicalOf(e)` (kanonik sort-kunci, `server_time`
disengaja di luar hash), `GENESIS_HASH = 'GENESIS'`.

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
checkAppend(type: string, payload: Record<string, unknown>): void; // fail-fast sebelum log tersentuh
MoneyState = { DRAFT, IOU_RECORDED, SETTLED_ONLINE, FAILED, EXPIRED };
```

Skema baca (`bayar`, `stock`, `stock_moves`, `records`, `conflicts`,
`_events`, `_meta`, `_quarantine`): `src/store.ts:SCHEMA`.
Uang jujur: offline = IOU; `SETTLED_ONLINE` hanya via settle/sync ack.

Modul tetangga: [sync-protocol](sync-protocol.md),
[retention](retention.md), [auth](auth.md).
