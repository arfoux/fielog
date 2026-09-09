# corruption-generator

Port of skill-9 (`corruption-generator`, status HEALTHY) to fielog: a
deterministic lib injecting one fault per run into the JSONL log, plus
detector tests proving each fault is caught on reopen.

## Files

- `scripts/corrupt-gen.ts` — `bitflip(path, lineNo)` + `tornTail(path)` +
  `truncateTail(path, dropLast)`; throws out of range, no randomness.
- `test/corrupt-gen.test.ts` — 3 detector tests via `health()` /
  `verifyLog()`; deterministic sibling of `test/corrupt.test.ts`
  (one handmade fault, read-only) and `test/kill9.test.ts`
  (real sigkill, read-only).
- `test/corrupt.test.ts` — reference pattern: mid-file bitrot -> `quarantined 1`,
  `gaps [6]`, `verify ok`, sync 9/9, reopen stable.

## Modes -> detectors (`src/log.ts` openLog)

| mode | injection | detection on reopen |
|---|---|---|
| `bitflip` | low bit of index 1 (`"` -> `#`) on a mid-file line, not last | `quarantined 1`, `gaps [line+1]`, `verify ok:true`, `events n-1` |
| `tornTail` | second half of the last line, no trailing newline (kill mid-append) | `repairedTail true`, `events n-1`, `verify ok:true` |
| `truncateTail` | drops n whole tail lines at a newline boundary (lost suffix) | `events n-drop`, `quarantined 0`, `verify ok:true`, prefix valid |

`bitflip` refuses the last line: that is `tornTail` territory. `truncateTail`
refuses `dropLast >= total`: never empty the log via the corruptor.

## Run

- `bun test test/corrupt-gen.test.ts`: 3 pass, 0 fail (~0.5s).
- `bun test test/corrupt.test.ts`: 1 pass, 0 fail (~0.5s, reference pattern still green).
- base: `d03e683` (`v0.14.13`), 35 test files; full suite not re-run
  here (soak/flake ~300s+, 120s timeout on the proof run).
