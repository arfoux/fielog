# relay

Native websocket transport over `Bun.serve`, zero dependencies
(`src/relay.ts`). The relay stays dumb: accept raw logs, broadcast, store.

## `WsRelayServer` (`src/relay.ts:14-27,62-...`)

```ts
interface WsRelayServerOpts {
  port?: number;            // 0 = ephemeral, read back via .port
  file?: string;            // JSONL persistence; loaded at boot
  hbMs?: number;            // server ping interval
  dropRate?: number;        // chaos 0..1 (deterministic via mulberry32)
  seed?: number;
  trustedDevices?: Record<string,string>; // deviceId -> pubkey PEM; non-empty = enforcement on
  revokeAdmins?: Record<string,string>;
  allowUnsigned?: boolean;  // legacy default open (dev); the CLI passes false unless --unsigned
}
```

| member | meaning |
|---|---|
| `start(): Promise<number>` | start; return the actual port. Refuse double start; fail-closed when `allowUnsigned === false` without devices |
| `kill(): void` | abrupt shutdown; in-flight requests die without ack |
| `port: number` | listen port (throws before start) |
| `size: number` | stored events |
| `storedIds(): string[]` | all UUIDs on disk (exact-once audit) |
| `registerDevice(id, pubPem): void` | register a device; enforcement turns on once one device is known (`enforcing`) |
| `revokeDevice(id): void` | tombstone a device: reject next push/pull, broadcast `revoked`, persist the `.revocations` sidecar |
| `isRevoked(id) / revokedIds()` | check / list revocations (tombstone + `*` log) |
| `issueRevoke(adminPrivPem, admin, input, now?): RevokeEvent` | admin-signed revocation into the convergent log (persist `.revoke-events`, fsync before ack) |
| `revokeSnapshot() / revokeCursor()` | byte-equal canonical view across replicas / local log length |
| `serverTime` | authoritative clock (`1_700_000_000_000` at start); counters `pushesReceived`, `pullsReceived`, `rejectsReceived`, ... |
| `mulberry32(seed)` | deterministic rng for chaos tests |

Crash model: every event is persisted to the JSONL file BEFORE ack — kill +
restart + client resume from the ack cursor = exact-once per UUID. `live`
broadcast is only a hint; pull is the source of truth.

## `WsRelayClient` (`src/relay.ts:551-559,571-856`)

```ts
interface WsRelayClientOpts { baseMs?: number; maxMs?: number; maxRetries?: number;
  reqTimeoutMs?: number; capToken?: CapToken; revokeAdmins?: Record<string,string>; }
new WsRelayClient(url: string, opts?: WsRelayClientOpts);
MAX_LIVE_HINTS = 1000;
```

| member | meaning |
|---|---|
| `push(batch): Promise<PushAck>` | push; protocol errors as `relay rejected push: ...` |
| `pull(since): Promise<{ events, cursor }>` | pull + merge live hints (UUID dedupe); live buffer is bounded |
| `setCapToken(t \| undefined): void` | rotate the token without redial |
| `syncRevokes(): Promise<{ added, skipped, rejected, serverCursor }>` | two-way revocation handshake (pull–offer–pull) |
| `pushRevokes / pullRevokes` | offer / fetch the raw revocation tail |
| `revokeSnapshot() / isTokenRevoked / isDeviceRevoked` | local convergent view + checks |
| `close(): void` | manual close |
| fields | `revokedNotices: string[]`, `liveCount`, `pingsReceived`, `reconnects`, `revokeSyncs`, `revokeRejected` |

Reconnects with backoff+jitter, resumes via cursor; ping/pong every `hbMs`
(default 1000 ms, drop after 3x).

## Usage patterns

- Test/dev: `MemoryRelay` (see [sync-protocol](sync-protocol.md)) or
  `WsRelayServer` without `trustedDevices` (open, dev only).
- Production: register each device (`--trust` in the CLI) + capability token
  per push/pull (see [auth](auth.md), [cli](cli.md)).
