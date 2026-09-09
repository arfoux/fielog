# architecture

fielog = append-only log (source of truth) + SQLite read-model + sync later.
Slogan: write anywhere, resolve later.

```
                ┌─────────────┐  push/pull delta   ┌──────────────┐
  append ──►    │ log (JSONL) │ ◄────────────────► │ relay (ws)   │
  query ◄──     │ ledger.log  │   ack cursor       │ relay.log    │
  undo   ──►    ├─────────────┤                    └──────────────┘
  resolve ──►    │ store       │
                │ (SQLite)    │   snapshot / truncate (retention)
                │ ledger.db   │ ──► ledger.snapshot.db
                └─────────────┘
```

## Layers (`src/`)

| module | file | role |
|---|---|---|
| log | `log.ts` | JSONL append-only: UUID per event, sha256 hash chain (`GENESIS` anchor), fsync per append, corrupt-line quarantine, torn-tail trim |
| store | `store.ts` | SQLite read-model (`bun:sqlite`): `entries` / `stock` / `conflicts` / `_events` / `_meta`; fail-fast `checkAppend` validation before the log is touched |
| kernel | `kernel.ts` | the `createKernel({ file })` facade: `append` / `query` / `undo` / `resolve` / `sync` / `conflicts` / `health` / `snapshot` / `truncate`. No network except `sync` |
| sync | `sync.ts` | delta push/pull per `seq` with ack cursors, idempotent per UUID, backoff, dead-letter, multi-relay failover, `MemoryRelay` for tests |
| deltasync | `deltasync.ts` | manifest-first sync between two replicas (`DeltaPeer { manifest, fetch }`), unsigned — for same-operator replicas |
| relay | `relay.ts` | native ws transport (`Bun.serve`): `WsRelayServer` file-backed + fsync + broadcast, `WsRelayClient` reconnect + heartbeat |
| auth | `auth.ts` | per-device ed25519 keypairs, authority grants, capability tokens, threshold countersignatures, revocation lists |
| retain | `retain.ts` | snapshot (`VACUUM INTO` + seal stamp) + truncate (new-file write + atomic rename) |
| tombstone | `tombstone.ts` | soft-delete as compensation events + gc-guard + local partial legal-hold |
| cas | `cas.ts` | content-addressed blob store (sha256 = key) for attachments |
| quota | `quota.ts` | standalone byte-ceiling admission control (no kernel wiring) |
| hashchain | `hashchain.ts` | hash-chain / quarantine utils |
| revokelog | `revokelog.ts` | convergent revocation log across relays and clients |

Per-subsystem details:

- kernel + store + log: [kernel-api](kernel-api.md)
- sync + deltasync + failover: [sync-protocol](sync-protocol.md)
- relay server + client: [relay](relay.md)
- snapshot + truncate: [retention](retention.md)
- auth + revocation: [auth](auth.md), deep dive [capability-token](capability-token.md)
- attachments: [cas-store](cas-store.md)
- soft-delete: [tombstone-engine](tombstone-engine.md)
- disk quota: [quota-guard](quota-guard.md)
- promises that must never be broken: [contracts](contracts.md)

## Principles visible from the code

- Log first, read-model second. `append` writes + fsyncs the log line, then
  `store.apply`; if apply fails, the line holds (durable) and is re-pushed
  via `healSplit` / replay on open (`src/kernel.ts:appendInner`).
- Wall clocks are display-only. `ts_device` never decides order;
  order belongs to the monotonic `seq` (`src/log.ts:LogEvent`).
- Dumb relays. Accept raw logs, broadcast, store — no business logic
  (`src/sync.ts`, `src/relay.ts` header).
- Pull is the source of truth; `live` broadcast is only a hint
  (`src/relay.ts:WsRelayClient.pull`, `MAX_LIVE_HINTS = 1000`).
