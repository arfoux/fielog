# fielog — Fieldlog

Write anywhere, settle later.

Offline-first primitives for apps that must survive bank-down, blank-spot,
blackout: append-only log (source of truth) + SQLite read-model + sync-later.

## Core API (v0.2)

```js
// example/kasir.mjs — runs with: bun example/kasir.mjs
import { createKernel, MemoryRelay } from '../src/index.ts';
const k = await createKernel({ file: 'kasir.db' });
const tx = await k.append({ type: 'bayar', nominal: 50000, oleh: 'budi' });
console.log(await k.query('SELECT sum(nominal) AS total FROM bayar WHERE voided = 0'));
// → [ { total: 50000 } ] — state is IOU_RECORDED (not paid), no network touched
await k.sync(new MemoryRelay()); // delta push/pull; pass your own Relay for wss
await k.undo(tx.id);
k.close();
```

`sync` takes a `Relay` object (`push`/`pull`, see `src/sync.ts` — `MemoryRelay`
is ~50 lines). For a real socket, `src/relay.ts` has `WsRelayServer` (Bun.serve,
file-backed so kill+restart resumes exact-once) + `WsRelayClient` (reconnect
with backoff, heartbeat, live broadcast hints):

```js
import { WsRelayServer, WsRelayClient } from './src/index.ts';
const server = new WsRelayServer({ port: 8090, file: 'relay.log' });
await server.start();
await k.sync(new WsRelayClient('ws://127.0.0.1:8090'));
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
