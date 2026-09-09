# Conformance gate (pre-merge)

`scripts/conformance-gate.sh` is the pre-merge gate for fielog spins.
It runs four checks; every check prints `PASS: <name> (<detail>)` or
`FAIL: <name> (<reason>)`, then a final `GATE: PASS` / `GATE: FAIL` line.
Exit code is 0 only when all four checks pass.

## Checks

| # | Name    | Rule | Reason on FAIL |
|---|---------|------|----------------|
| 1 | `base`  | `git merge-base HEAD <main-ref>` equals the `<main-ref>` tip (default `main`) | `merge-base X != main tip Y; rebase onto main`, or `ref not found` |
| 2 | `tree`  | `git status --porcelain` is empty | `dirty: <first 5 lines>` |
| 3 | `tests` | `bun test` reports exactly `EXPECTED_PASS` passes and `0` failures (default 66/0) | `bun test P/F, expected E/0` |
| 4 | `scope` | every file in `git diff --name-only <base>...HEAD` is in the spin allowlist (`scripts/conformance-gate.sh`, `docs/conformance-gate.md`) | `out-of-scope: <files>; allowlist: ...` |

## Usage

```sh
bash scripts/conformance-gate.sh [--expected-pass N] [--main-ref REF]
GATE_EXPECTED_PASS=66 GATE_MAIN_REF=main bash scripts/conformance-gate.sh
```

`--expected-pass` exists so a spin can pin its own green count, and so a
FAIL can be simulated on purpose (see below). `GATE_*` env vars do the same.

## Proving the gate (w2-conformance-gate)

1. Own worktree, committed, on top of `main` tip `a9a6b41`:
   `bash scripts/conformance-gate.sh` must print `GATE: PASS` with
   `tests (bun test 66/0, expected 66/0)`.
2. Simulated FAIL: `bash scripts/conformance-gate.sh --expected-pass 64`
   must print `GATE: FAIL` with
   `FAIL: tests (bun test 66/0, expected 64/0)`.

Full `bun test` takes ~270 s (model-fuzz oracle + soak dominate), so each
proof run takes about five minutes. Phase-2 (merge + tag) runs only on
coordinator inbox instruction, never unilaterally.
