# relay

Transport websocket asli di atas `Bun.serve`, tanpa dependensi
(`src/relay.ts`). Relay tetap bodoh: terima log mentah, broadcast, simpan.

## `WsRelayServer` (`src/relay.ts:14-27,62-...`)

```ts
interface WsRelayServerOpts {
  port?: number;            // 0 = ephemeral, baca balik via .port
  file?: string;            // persistensi JSONL; dimuat saat boot
  hbMs?: number;            // interval ping server
  dropRate?: number;        // chaos 0..1 (deterministik via mulberry32)
  seed?: number;
  trustedDevices?: Record<string,string>; // deviceId -> pubkey PEM; non-kosong = enforcement nyala
  revokeAdmins?: Record<string,string>;
  allowUnsigned?: boolean;  // default warisan terbuka (dev); CLI meneruskan false kecuali --unsigned
}
```

| member | arti |
|---|---|
| `start(): Promise<number>` | nyalakan; kembalikan port aktual. Tolak start ganda; fail-closed bila `allowUnsigned === false` tanpa device |
| `kill(): void` | matikan abrupt; request in-flight mati tanpa ack |
| `port: number` | port listen (throw bila belum start) |
| `size: number` | event tersimpan |
| `storedIds(): string[]` | semua UUID di disk (audit exact-once) |
| `registerDevice(id, pubPem): void` | daftarkan device; enforcement nyala sejak satu device dikenal (`enforcing`) |
| `revokeDevice(id): void` | tombstone device: tolak push/pull berikut, broadcast `revoked`, persist sidecar `.revocations` |
| `isRevoked(id) / revokedIds()` | cek / daftar revoke (tombstone + log `*`) |
| `issueRevoke(adminPrivPem, admin, input, now?): RevokeEvent` | revoke bertanda admin ke log konvergen (persist `.revoke-events`, fsync sebelum ack) |
| `revokeSnapshot() / revokeCursor()` | view kanonik byte-equal antar replika / panjang log lokal |
| `serverTime` | jam otoritatif (`1_700_000_000_000` awal); counter `pushesReceived`, `pullsReceived`, `rejectsReceived`, ... |
| `mulberry32(seed)` | rng deterministik untuk chaos test |

Crash model: tiap event dipersist ke file JSONL SEBELUM ack — kill + restart +
resume client dari ack cursor = exact-once per UUID. Broadcast `live` hanya
hint; pull sumber kebenaran.

## `WsRelayClient` (`src/relay.ts:551-559,571-856`)

```ts
interface WsRelayClientOpts { baseMs?: number; maxMs?: number; maxRetries?: number;
  reqTimeoutMs?: number; capToken?: CapToken; revokeAdmins?: Record<string,string>; }
new WsRelayClient(url: string, opts?: WsRelayClientOpts);
MAX_LIVE_HINTS = 1000;
```

| member | arti |
|---|---|
| `push(batch): Promise<PushAck>` | dorong; error protokol sebagai `relay rejected push: ...` |
| `pull(since): Promise<{ events, cursor }>` | tarik + gabung hint live (dedupe UUID); buffer live dibatasi |
| `setCapToken(t \| undefined): void` | rotasi token tanpa redial |
| `syncRevokes(): Promise<{ added, skipped, rejected, serverCursor }>` | handshake revoke dua arah (pull–offer–pull) |
| `pushRevokes / pullRevokes` | tawar / ambil ekor revoke mentah |
| `revokeSnapshot() / isTokenRevoked / isDeviceRevoked` | view konvergen lokal + cek |
| `close(): void` | tutup manual |
| lapang | `revokedNotices: string[]`, `liveCount`, `pingsReceived`, `reconnects`, `revokeSyncs`, `revokeRejected` |

Reconnect dengan backoff+jitter, resume via cursor; ping/pong tiap `hbMs`
(default 1000 ms, drop setelah 3x).

## pola pakai

- Test/dev: `MemoryRelay` (lihat [sync-protocol](sync-protocol.md)) atau
  `WsRelayServer` tanpa `trustedDevices` (terbuka, dev saja).
- Produksi: daftarkan tiap device (`--trust` di CLI) + token kapabilitas
  per push/pull (lihat [auth](auth.md), [cli](cli.md)).
