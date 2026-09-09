# flake-hunter

Port of skill-1 (`flake-hunter`, status SOLID) to fielog.
Loop the flaky target N times, keep every per-run log, label each
failure `env` (timing/socket/resource) or `product`
(assertion/invariant), and print a pass-rate summary.
Ambiguous logs default to `product` so a real bug is never
filed as "just flakes".

Related pattern: `watchdog.sh --from-json` (canned input for
dry-runs/tests) becomes `flake-hunter.sh --from-log` here.

## usage

```sh
bash scripts/flake-hunter.sh --target <file> [--test-name <substr>] [--runs N]
bash scripts/flake-hunter.sh --from-log <file>
```

| flag | default | meaning |
| --- | --- | --- |
| `--target` | - | test file to rerun (required unless `--from-log`) |
| `--test-name` | all | `bun test -t` filter, e.g. one soak seed |
| `--runs` | 10 | loop count, positive integer |
| `--from-log` | - | classify one captured failure log, no loop (fixtures/tests) |

Per-run logs land in
`${TMPDIR:-${TEMP:-${TMP:-/tmp}}}/flake-hunter-<utc-stamp>/run-<i>.log`
(never hardcoded `/tmp`: Windows hosts have no `/tmp`).

## exit codes

| code | meaning |
| --- | --- |
| 0 | loop done with no product failure (all pass, env-only flakes, or `--from-log` env/pass) |
| 2 | at least one product failure (`--from-log` product included) |
| 1 | usage/environment error (bad flags, `bun` missing, target/log unreadable) |

## classification rule

`product` patterns win over `env` patterns; no pattern at all
means `product unknown-failure-no-pattern`.

- `env`: `timed out`, `waitfor`, `eaddrinuse`, `econnrefused`,
  `econnreset`, `epipe`, `enotfound`, `address already in use`,
  `no space left`, `out of memory`, `cannot allocate`, ws `1006` /
  `websocket ... closed|timeout`.
- `product`: `assert`, `assertion`, `exact-once`, `diverges`,
  `corrupt`, `gaps`, `ack regress`, `duplicates`, `lost acked`,
  `quarantine`, `verifylog`, `unconverged`, `missing events`.

## env-vs-product per candidate

| target | env flake shape | product shape (real bug) |
| --- | --- | --- |
| `test/kill9.test.ts` (`waitFor` helper :11-17, SIGKILL strike :29-37, 60 s budget :63) | `waitFor timed out`: child slow to append 50 lines on a loaded box; kill lands after the run instead of mid-flight | `verifyLog` not ok / `gaps != []` (:43-45), totals diverge from the log file (:57-59): torn-tail repair broken |
| `test/skew.test.ts` (MemoryRelay sync :26-27, 30 s budget :44) | almost none: no sockets, no sleeps, fixed clock closure | any failure: ordering follows `ts_device` instead of `seq`, or totals off (:34-39) |
| `test/failover.test.ts` (memory cases :27-117; real sockets :119-150, `crashAfter = 1` :136, 30 s budget :150) | `EADDRINUSE`, ws `1006`, handshake/connect timeout on real sockets (:121-133) | `acked != 20`, relay duplicates, union `!= 20`, secondary short (:138-149) |
| `test/soak.test.ts` (`runSoak` :83-144, invariants :50-81, 55 s budget :148, unseeded run :150-154) | `55 s` timeout on a slow box; the unseeded case picks a fresh seed per run so only it can wander | `sql total diverges` (:61-63), `relay holds duplicates` (:80), `ack regressed` (:71, :118), `unconverged tail` (:139-140) |

The skill pattern applied without invention: fielog's flaky
surface is exactly timing (kill9 `waitFor`), sockets (failover
ws, relay-ws), and long budgets (soak/model-fuzz) — the same
three shapes the loop+classify pattern covers. Minimal
adaptation: target is a `bun test` file (+ `-t` filter) and
canned input is a log file (`--from-log`).
## loop evidence (2026-09-06, this worktree, base `0bb7803`)

Zero live failures, so per-failure classification is proven on

fixtures (see below), not on a forced red run. Nothing was
broken on purpose to manufacture a failure.

```text
$ bash scripts/flake-hunter.sh --target test/kill9.test.ts --runs 20
[flake-hunter] summary target=test/kill9.test.ts runs=20 pass=20 fail=0 env=0 product=0 pass_rate=100%

$ bash scripts/flake-hunter.sh --target test/failover.test.ts --runs 10
[flake-hunter] summary target=test/failover.test.ts runs=10 pass=10 fail=0 env=0 product=0 pass_rate=100%

$ bash scripts/flake-hunter.sh --target test/skew.test.ts --runs 10
[flake-hunter] summary target=test/skew.test.ts runs=10 pass=10 fail=0 env=0 product=0 pass_rate=100%

$ bash scripts/flake-hunter.sh --target test/soak.test.ts --test-name "seed 7" --runs 3
[flake-hunter] summary target=test/soak.test.ts runs=3 pass=3 fail=0 env=0 product=0 pass_rate=100%
```

Classifier fixtures (`--from-log`, exit in brackets):

```text
waitFor timed out... (fail)   -> class=env (exit 0)
diverges from model... (fail) -> class=product (exit 2)
ws 1006 + acked mismatch      -> class=product, product wins (exit 2)
(fail) with no known pattern  -> class=product unknown-failure-no-pattern (exit 2)
1 pass / 0 fail log           -> class=pass (exit 0)
```

Regression proof: `bun test test/flake-hunter.test.ts` -> 8 pass,
0 fail (7 classifier cases + 1 live skew loop of 2 runs).

## base proof (mismatch-stop precondition)

```text
$ git rev-parse HEAD
0bb7803af27265d7042f8121b19b711ce81a3284
$ bun test 2>&1 | tail -4
 66 pass
 0 fail
Ran 66 tests across 28 files. [413.90s]
```

Run started before `test/flake-hunter.test.ts` existed, so 28 files
is the base set: base `0bb7803` is green 66/0 -> PASS. With the new
regression file the suite becomes 29 files / 74 tests.

## limits (by design)

- The loop reruns whole files (or one `-t` filter), not single
  `it` blocks by line number.
- `env` means "looks like the machine/network", not "safe to
  ignore": repeated env flakes on the same target still deserve
  a longer budget or quarantine, decided by a human.
- Phase-2 (merge + tag) runs only on coordinator inbox
  instruction, never unilaterally.
