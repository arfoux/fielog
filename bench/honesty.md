# bench honesty (healthy)

Port of skill-7 (`bench-honesty`, status SOLID) to fielog.
HEALTHY = slice + corpus + machine recorded; numbers without all three are rejected.
A bench number is a claim; the three pins are the proof. Any pin
mismatch -> STOP, do not quote the number (see `docs/mismatch-stop.md`).

Related field skills: 46 (state dir via `$TEMP`, never hardcoded `/tmp`),
37 (the script reports raw pins, the coordinator judges), 65
(exit-code convention 0/1/2 source).

## rules

1. slice: exact code version. Every reported number names the git HEAD
   it was measured on (`git rev-parse HEAD`). Re-run after any code
   change; numbers from another commit are stale, not "close enough".
2. corpus: exact workload. Bench name + N + the fixed workload params
   in `bench/*.ts` (append: `amount` 1000..9999, `actor: bench`;
   query: 200 iters, 10 warmup, `maxPending` N+1000; sync: chunk 500,
   real ws relay). Changing N or params = new corpus = new number.
3. machine: exact machine + runtime. OS, arch, `bun --version` at minimum
   (cpu/ram/disk once per machine, in `docs/bench.md`). Numbers from
   another machine are not comparable.
4. checker gate: `scripts/bench-check.sh` verifies pins before a number
   is accepted. Any FAIL -> `HONESTY: FAIL`, exit 2, STOP.
5. no estimates: every number in this doc is a real measurement from
   the machine below. Estimates, projections, and "should be" are
   rejected by the checker (no RESULT line = FAIL).

## usage

```sh
scripts/bench-check.sh --bench append|query|sync [--n N] [--run]
  [--from-output FILE] [--record]
  [--expect-head HASH] [--expect-bun VER]
```

| flag | meaning |
| --- | --- |
| `--bench` | required: which bench (`bench/bench-<name>.ts` must exist) |
| `--n` | corpus size; defaults: append 5000, query 100000, sync 10000 |
| `--run` | execute the bench now, validate its RESULT line, print pins |
| `--from-output` | validate a captured log instead of running |
| `--record` | print current pins only, no bench run |
| `--expect-head` | slice pin: HEAD must equal (or start with) this hash |
| `--expect-bun` | machine pin: `bun --version` must equal this |

Exit codes: 0 pins ok (HONESTY: PASS); 2 mismatch or invalid bench
output (HONESTY: FAIL); 1 usage/environment error.

## evidence run (2026-09-06, slice d03e683 = v0.14.13)

Applied to one real bench: `bench/bench-append.ts` (bench/bench-append.ts:1-26),
corpus n=2000, via the checker:

```text
$ bash scripts/bench-check.sh --bench append --n 2000 --run \
    --expect-head d03e683b8e40acf3a484617cdfd42a254a61a358 --expect-bun 1.4.0
[bench-check] slice head=d03e683b8e40acf3a484617cdfd42a254a61a358 bench_file=bench/bench-append.ts
[bench-check] corpus n=2000 amount=1000+(i%9000) actor=bench
[bench-check] machine os=MINGW64_NT-10.0-26100 arch=x86_64 bun=1.4.0
append: n=2000 total_s=20.10 append_per_sec=99
append per-op ms: p50=9.427 p99=19.211 n=2000
RESULT {"bench":"append","n":2000,"total_s":20.1017128,"append_per_sec":99.49400928661163,"per_op_ms":{"p50":9.427399999996851,"p99":19.210799999997107,"n":2000}}
HONESTY: PASS bench=append head=d03e683b8e40acf3a484617cdfd42a254a61a358 bun=1.4.0 corpus="n=2000 amount=1000+(i%9000) actor=bench" log=/tmp/bench-check-append-2000.log
```

Checker rejects a wrong slice pin (exit 2, number not quoted):

```text
$ bash scripts/bench-check.sh --bench append --expect-head deadbeef
HONESTY: FAIL bench=append slice mismatch head=d03e683b8e40acf3a484617cdfd42a254a61a358 expect=deadbeef
exit=2
```

Note: 99 append/sec here vs 435 append/sec in `docs/bench.md`
(docs/bench.md:34, measured 2026-09-05). Different wall-clock on a
loaded laptop, same machine and runtime — that is exactly why rule 3
exists: the number is only valid with its pins, and cross-day numbers
are not comparable.

## precondition suite (base d03e683, green claim 88/0/35)

```text
evidence base-hash:
  command: git rev-parse HEAD
  actual:   d03e683b8e40acf3a484617cdfd42a254a61a358
  matches base d03e683 -> PASS

evidence file-scope:
  command: pwd; git status --short
  actual:   C:/Users/HP/orca/workspaces/fielog/w3b-bench, clean
  only touches bench/honesty.md + scripts/bench-check.sh -> PASS

evidence test-count:
  command: bun test 2>&1 | tail -4
  actual:   88 pass, 0 fail, 35 files, 427.84s
  matches green base claim 88/0/35 -> PASS
```

## limits (by design)

- Single real bench applied (append): query (100k build ~260 s) and
  sync (real ws relay, timing-sensitive) stay on their defaults in
  `docs/bench.md` until a spin pins and runs them through the checker.
- Machine pin covers os/arch/bun only; cpu throttling and background
  load are not detectable — re-run, do not average across days.
- Phase-2 (merge + tag) is never done by this script or doc; the
  coordinator acts via its own inbox.
