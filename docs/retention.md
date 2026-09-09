# retention

Bound the log without losing truth: snapshot + truncate (`src/retain.ts`).
Only the already-acked prefix (already held by the relay) may be swept,
and cutover always writes a new file + atomic rename.

## API (`src/retain.ts`)

```ts
interface SnapshotResult { snapshot: string; sealedSeq: number; dbSeq: number }
interface TruncateResult { removed: number; kept: number; sealedSeq: number }
snapshotPathFor(dbPath: string): string; // 'ledger.db' -> 'ledger.snapshot.db'
takeSnapshot(store, dbPath, sealedSeq, dest?): SnapshotResult;
// Online full copy (VACUUM INTO) + seal stamp in the snapshot AND live meta.
clampSealToStored(store, logSeqs, sealed, ackSeq): number;
// Clamp the seal to the sweep-safe prefix (max = acked & applied).
sweepLogFile(logPath, sealedSeq, syncDir?): TruncateResult;
// Sweep lines with seq <= sealedSeq. New file = marker + kept lines; atomic rename.
```

Via the kernel (`src/kernel.ts`): `snapshot(dest?)`, `truncate()`.
`truncate` is a no-op when unsealed (`sealed <= 0`), and reopens the log fd
in `finally` so the kernel stays usable whatever happens.
After a sweep, incremental replay of the kept suffix + `exciseMissing` with
`sealedBelow` (swept prefix forgiven, quarantine not).

## Usage flow

```ts
await k.snapshot();    // seal the acked prefix into ledger.snapshot.db
await k.truncate();    // sweep the sealed prefix from ledger.log
```

The first line of a swept log = the `fielog-truncate` marker chaining the
suffix to the discarded prefix, so `verifyLog` stays whole.

## Binding rules

- `seal <= ack`: a sweep must never delete unacked or unapplied data;
  a stale seal = safe no-op (see [contracts](contracts.md)).
- `guardSeal` (see [tombstone-engine](tombstone-engine.md)) is stricter
  still: hold legal-hold events and never split hide/target pairs.
- Overlapping double snapshots over the same db are rejected loudly
  (`snapshotsInFlight`), not interleaved.
