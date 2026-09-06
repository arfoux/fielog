# delta-sync

Manifest-first delta sync between two fielog replicas (`src/deltasync.ts`).
Port of skill-13 (`delta-sync`, status MANTAP) to fielog.

## protocol

In order, nothing skipped:

1. `manifest` — receiver pulls the sender manifest `{ v: 1, count, tip, ids[] }` first.
2. `want-list` — receiver diffs sender ids against its local UUID set (`computeWant`).
3. `fetch` — receiver fetches only the want-list, in chunks, in manifest order.
4. `apply` — each event appends under a fresh local seq, idempotent by UUID.
5. `resume` — want-list remainder persists per chunk in store meta
   (`<cursorKey>.want`); re-call after a cut continues where it stopped.

```ts
import { openLog } from './src/log.js';
import { openStore } from './src/store.js';
import { createMemoryPeer, syncDelta } from './src/deltasync.ts';

const peer = createMemoryPeer(senderLog);
const res = await syncDelta(recvLog, recvStore, 'device-b', peer, { chunkSize: 50 });
// res = { wanted, fetched, applied, resumed, done }
```

## guarantees

- Idempotent by UUID: replays and refetches never duplicate rows
  (`store.hasId` / `log.hasId` short-circuit; logged-but-not-stored re-drives).
- Poison never pins: shape-invalid events dead-letter, the want-list still drains.
- Crash-safe: plan persists before chunk 1; every chunk re-persists the remainder.
- Manifest growth: a fresh manifest merges with the persisted remainder,
  so sender appends during an outage still land.
- Stalled peer converges: two consecutive chunks with zero progress return
  `done: false` (remainder stays persisted); the next call retries.

## non-goals

- No signature verification here: peers are trusted replicas of one operator.
  Forgery-gated pull with a device registry stays on `pullRemote` (`src/sync.ts`).
- No transport in this file: `DeltaPeer` is `{ manifest, fetch }` — memory,
  file, or ws backed. `createMemoryPeer` covers tests and local dev.

## proofs

`test/deltasync.test.ts` (3 tests):

- full sync: manifest called before any fetch, `wanted == applied == 20`, totals match.
- mid-cut resume: injected `mid-transfer` cut on chunk 2, cursor persisted
  (`deltasync.want` holds 13 ids), resume completes 20/20 with zero duplicate UUIDs.
- replay idempotent: second run is a no-op (`wanted == applied == 0`).
