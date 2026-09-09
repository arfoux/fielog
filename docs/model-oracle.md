# model-oracle

Model calculator (~35 lines) + state-vs-implementation comparison every 100
steps. Port of skill-6 SOLID to fielog: a plain-arithmetic oracle mirroring
`route()` routing in `src/store.ts` (only `entry` / `tally.add` / `tally.remove` /
`undo.compensate` cases), comparison results reported loudly with seed + step
+ op log.

## Files

- `scripts/model-oracle.ts` — `Oracle` (~35 lines) + `checkOracle` (3 SELECTs
  vs the read-model: per-actor live sums, tally qty, voided id set).
- `test/model-oracle.test.ts` — 1000 seeded mixed ops (`20260906`), check
  every 100 steps + final converge; lightweight deterministic sibling of
  `test/model-fuzz.test.ts` (5000 steps, inline oracle — read-only).
- `model-fuzz-report.md` — the original fuzz report (66/0 number evidence,
  35-line oracle).

## mapping store.ts -> oracle

| store.ts `route()` | oracle |
|---|---|
| `entry` insert + `resolvePendingEntries` (early undo -> void) | `entry()`: `pend` -> `void`, else `pay[actor] += n` |
| `tally.add` adds qty + records move | `add()`: `pend` -> `void`, else `stk[item] += q`, `mov[id]` |
| `tally.remove` underflow -> move voided + conflict, without reducing tally | `sell()`: short tally -> `void`, else `stk[item] -= q`, `mov[id] = -q` |
| `undo.compensate` entry -> void; live move -> void + qty refund; unknown -> parks in `records` | `undo()`: live entry -> reduce `pay`, void; live move -> `stk -= signed`, void; unknown -> `pend` |
| target landing after a parked undo -> `resolvePendingEntries` voids it | `entry/add/sell` checks `pend` first — same effect oracle-side |
Deliberately out of scope (like fuzz): `entry.*` / resolve transitions —
the op mix is only entry/undo/tally + kill-respawn/sync/replay.


## run

- `bun test test/model-oracle.test.ts`: 1 pass, 0 fail, 21.50s —
  oracle matches the kernel on all 10 checks + final, zero divergence.
- full suite after adding the file: 67 pass, 0 fail, 338.56s, 29 files
  (base 66/0 + 1 new test) — zero divergence on all oracle checks.
