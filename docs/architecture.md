# architecture

fielog = append-only log (sumber kebenaran) + SQLite read-model + sync belakangan.
Slogan: tulis di mana saja, settle nanti.

```
                ┌─────────────┐  push/pull delta   ┌──────────────┐
  append ──►    │ log (JSONL) │ ◄────────────────► │ relay (ws)   │
  query ◄──     │ kasir.log   │   ack cursor       │ relay.log    │
  undo   ──►    ├─────────────┤                    └──────────────┘
  settle ──►    │ store       │
                │ (SQLite)    │   snapshot / truncate (retensi)
                │ kasir.db    │ ──► kasir.snapshot.db
                └─────────────┘
```

## lapisan (`src/`)

| modul | file | peran |
|---|---|---|
| log | `log.ts` | JSONL append-only: UUID per event, rantai hash sha256 (`GENESIS` anchor), fsync per append, karantina baris korup, potong ekor robek |
| store | `store.ts` | read-model SQLite (`bun:sqlite`): `bayar` / `stock` / `conflicts` / `_events` / `_meta`; validasi `checkAppend` fail-fast sebelum log tersentuh |
| kernel | `kernel.ts` | fasad `createKernel({ file })`: `append` / `query` / `undo` / `settle` / `sync` / `conflicts` / `health` / `snapshot` / `truncate`. Tanpa jaringan kecuali `sync` |
| sync | `sync.ts` | delta push/pull per `seq` dengan cursor ack, idempoten per UUID, backoff, dead-letter, failover multi-relay, `MemoryRelay` untuk test |
| deltasync | `deltasync.ts` | sync manifest-first antar dua replika (`DeltaPeer { manifest, fetch }`), tanpa tanda — untuk replika satu operator |
| relay | `relay.ts` | transport ws asli (`Bun.serve`): `WsRelayServer` file-backed + fsync + broadcast, `WsRelayClient` reconnect + heartbeat |
| auth | `auth.ts` | keypair ed25519 per device, grant otoritas, token kapabilitas, countersign threshold, revoke list |
| retain | `retain.ts` | snapshot (`VACUUM INTO` + stempel seal) + truncate (tulis-file-baru + rename atomik) |
| tombstone | `tombstone.ts` | soft-delete sebagai event kompensasi + gc-guard + legal-hold parsial lokal |
| cas | `cas.ts` | blob store content-addressed (sha256 = kunci) untuk lampiran |
| quota | `quota.ts` | admission control byte-ceiling standalone (tanpa wiring kernel) |
| hashchain | `hashchain.ts` | util rantai hash / karantina |
| revokelog | `revokelog.ts` | log revoke konvergen antar relay dan client |

Detail per subsistem:

- kernel + store + log: [kernel-api](kernel-api.md)
- sync + deltasync + failover: [sync-protocol](sync-protocol.md)
- relay server + client: [relay](relay.md)
- snapshot + truncate: [retention](retention.md)
- auth + revoke: [auth](auth.md), pendalaman [capability-token](capability-token.md)
- lampiran: [cas-store](cas-store.md)
- soft-delete: [tombstone-engine](tombstone-engine.md)
- kuota disk: [quota-guard](quota-guard.md)
- janji yang tidak boleh dilanggar: [contracts](contracts.md)

## prinsip yang terlihat dari kode

- Log dulu, read-model kemudian. `append` menulis + fsync baris log, baru
  `store.apply`; kalau apply gagal, baris tahan (durable) dan didorong ulang
  via `healSplit` / replay saat buka (`src/kernel.ts:appendInner`).
- Jam dinding hanya pajangan. `ts_device` tidak pernah memutuskan urutan;
  urutan milik `seq` monotonik (`src/log.ts:LogEvent`).
- Relay bodoh. Terima log mentah, broadcast, simpan — tanpa logika bisnis
  (`src/sync.ts`, `src/relay.ts` header).
- Pull adalah sumber kebenaran; broadcast `live` hanya hint
  (`src/relay.ts:WsRelayClient.pull`, `MAX_LIVE_HINTS = 1000`).
