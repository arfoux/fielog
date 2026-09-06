# tombstone-engine

Soft-delete + gc-guard + partial legal-hold over the append-only log.
Implementation: `src/tombstone.ts`. Tests: `test/tombstone.test.ts` (7 tests).
No existing file was changed (`retain.ts` read-only, `store.ts` / `kernel.ts` /
`index.ts` untouched); the module only uses the public `EventStore` / kernel
surface, so there is no schema migration and old replicas replay cleanly.

## contract

- Soft-delete is a compensating event, never a rewrite. `hide` appends
  `tombstone.hide` (`src/tombstone.ts:109`); the target line stays in the log
  (auditable, syncable, replayable) and readers exclude it via `isHidden` /
  `hiddenIds` (`src/tombstone.ts:84`, `:93`). `show` (`src/tombstone.ts:128`)
  appends `tombstone.show` and lifts the hide. Fold is seq-ordered, so a hide
  that arrives before its target still converges on replay.
- Tombstones are ordinary events: they travel through `sync` to peers and
  survive reopen/truncate like any other line (proven by test, not by claim).
- Fail-fast like `checkAppend`: `hide` on an unknown id throws
  `ERR_UNKNOWN_TARGET` and `show` on a non-hidden id throws `ERR_NOT_HIDDEN`
  *before* appending, so a typo never leaves a poison line behind.
- GC-guard (`guardSeal`, `src/tombstone.ts:180`) clamps a truncate seal so it
  never (a) removes unacked/unapplied data (delegates to `clampSealToStored`),
  (b) sweeps a legally-held event, or (c) splits a hide/target pair across
  the sweep boundary. A split seal clamps below *both* seqs (fixpoint: one
  clamp can expose the next split). Returns `{ effective, held, pairs }` so
  the caller reports held-vs-swept honestly; `effective 0` means sweep nothing.
- Legal-hold is partial and local. Partial: per event id in `_meta`
  (`hold` / `release` / `isHeld` / `holds`, `src/tombstone.ts:145-161`), so one
  held seq defers only itself and everything above it — the prefix below still
  sweeps. Local: holds live in the device db like the snapshot seal; they do
  not sync. Set them per replica.

## honesty limits (read before relying)

1. Visibility is a read-model convention, not encryption: raw
   `kernel.query` SQL still sees hidden rows. Erasure against an adversary is
   out of scope — the log is append-only by design.
2. Holds do not propagate: a peer that never ran `hold` may sweep its own
   copy. Coordinate per replica for real legal matters.
3. There is no hard-delete path in this module: bytes leave the log only via
   the existing snapshot+truncate flow, and only when unheld and pair-whole.

## api

| symbol | file:line | effect |
|---|---|---|
| `hide(k, id, {actor, reason})` | `src/tombstone.ts:109` | append `tombstone.hide`; throws `ERR_UNKNOWN_TARGET` first |
| `show(k, store, id, {actor})` | `src/tombstone.ts:128` | append `tombstone.show`; throws `ERR_NOT_HIDDEN` first |
| `isHidden / hiddenIds / listTombstones` | `src/tombstone.ts:93` / `:84` / `:62` | fold hides minus shows in seq order; bad bodies skipped |
| `hold / release / isHeld / holds` | `src/tombstone.ts:145-161` | per-id local hold in `_meta` |
| `guardSeal(store, logSeqs, sealed, ackSeq)` | `src/tombstone.ts:180` | safe seal + `{held, pairs}` report |

Wire `guardSeal` in front of `sweepLogFile`: sweep `report.effective`, and when
`effective < sealed` tell the operator which `held` entries blocked and which
`pairs` would have split — never claim deletion of bytes still on disk.

## verification

```
bun test test/tombstone.test.ts 2>&1 | tail -4   # 7 pass, 0 fail
bun test 2>&1 | tail -4                          # 95 pass, 0 fail, 36 files
```
