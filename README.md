# fielog — Fieldlog

Write anywhere, settle later.

Offline-first primitives for apps that must survive bank-down, blank-spot,
blackout: append-only log (source of truth) + SQLite read-model + sync-later.

## Core API (v0.1 target)

```ts
import { createKernel } from 'fielog'
const k = await createKernel({ file: 'kasir.db' })
await k.append({ type: 'bayar', nominal: 50000, oleh: 'budi' })
const rows = await k.query('SELECT sum(nominal) FROM bayar')
await k.sync('wss://relay-anda')
await k.undo(lastId)
```

## Rules (non-negotiable)

1. Local-first: `append` + `query` never need network. Sync is background delta (by `seq`), resumable, idempotent by UUID.
2. Money honesty: states are `DRAFT → IOU_RECORDED (not paid) → SETTLED_ONLINE | FAILED/EXPIRED`. There is NO `PAID_OFFLINE` for QRIS/bank money.
3. Files stay boring: `kasir.db` (plain SQLite, opens in DBeaver) + `kasir.log` (JSONL append-only, `tail -f` friendly).
4. Relay is dumb: accept raw log, broadcast, store. No business logic. Replaceable in ~50 lines.
5. Conflicts are explicit: concurrent writes on contended stock/money become `conflict` rows for human reconcile — never silent last-write-wins on money.
6. Clocks are untrusted: local order by `(monotonic_seq, device_id)`; authoritative time only from server ack (`server_time`). HLC for cross-device merge.

## Layout

- `src/kernel.ts` — createKernel, append/query/undo/sync
- `src/log.ts` — JSONL append, fsync, hash chain, UUID per event
- `src/store.ts` — SQLite apply/replay/materialize
- `src/sync.ts` — delta push/pull, ack cursor, retry/backoff
- `src/auth.ts` — capability keys, revocable scopes, countersign over threshold
- `test/` — offline kasir flow, sync resume, undo, conflict surfacing
