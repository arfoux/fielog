# soak runner

Port of skill-3 (`soak-runner`, status SOLID) to fielog.
One script drives seeded random interleavings of `append` / `seal`
(`snapshot` + `truncate`) / `sync` / `restart`, checking invariants every
N steps and at the end. The killer case is seal collision: colliding
snapshots must sweep only the sealed prefix, never the unacked suffix.

Related field skills: 46 (`portabilitas-watchdog`, state dir via
`$TEMP`, never hardcoded `/tmp` — the test uses `os.tmpdir()`), 37
(`disiplin-false-alarm`, the script reports raw counts, the coordinator
judges), 65 (`daemon-gabungan`, exit-code convention 0/1/2 source).

## usage

```sh
scripts/soak-runner.sh [--seed N] [--steps N] [--check-every N]
  [--killer-only] [--filter PATTERN]
```

| flag | default | meaning |
| --- | --- | --- |
| `--seed` | 42 (`$SOAK_SEED`) | rng seed; single seeded run + killer case |
| `--steps` | 200 (`$SOAK_STEPS`) | random ops per run |
| `--check-every` | 20 (`$SOAK_CHECK_EVERY`) | invariant check cadence |
| `--killer-only` | off | run only the seal-collision case |
| `--filter` | - | raw `bun test --test-name-pattern` passthrough |

Without flags the underlying test file runs all fixed seeds
(`7, 42, 20260905`) plus the killer case:

```sh
bun test test/soak-runner.test.ts
```

Requirements: `bun` on `PATH`. `MemoryRelay` only (no sockets), so each
seed stays far under 60 s.

## ops

Seeded `mulberry32` picks one op per step:

| op | share | effect |
| --- | --- | --- |
| `append` | ~45% | `bayar` with random nominal; model records id + total |
| `seal` | ~15% | `snapshot()` always, `truncate()` on coin flip |
| `sync` | ~20% | `sync(relay)` with random chunk size; injected drops tolerated, regression is not |
| `restart` | ~20% | close without cleanup + reopen on the same files; ack cursor must survive |

## invariants (every N steps + final)

1. `verifyLog` clean, zero quarantined.
2. `SUM(nominal)` over live `bayar` equals the model total; live count matches.
3. `ackSeq` never regresses and never exceeds appended total; every acked
   seq is present in `_events` (truncate sweeps the log file, never the
   store — the db keeps answering the full prefix); relay holds every
   acked event.
4. Seal discipline: `snapshot.sealed_seq` never covers unacked data and
   never regresses.
5. Relay exact-once by UUID.

## killer case: seal collision

Two snapshots collide on the same ack prefix (10 synced, 3 appended
unacked, second `snapshot()` must still seal exactly 10). The seal
survives a close + reopen, then `truncate()` must report
`{ removed: 10, kept: 3, sealedSeq: 10 }` — the unacked suffix intact,
totals and `verifyLog` clean. Draining the suffix, sealing at 13, and
sweeping again yields `{ removed: 3, kept: 0, sealedSeq: 13 }`.

## Run evidence (2026-09-06, base 0bb7803 = v0.14.6)

```text
$ bun test test/soak-runner.test.ts
[soak-runner] seed=7 ops=200 invariant_checks=11 ack=79 sealed=79
[soak-runner] seed=42 ops=200 invariant_checks=11 ack=86 sealed=86
[soak-runner] seed=20260905 ops=200 invariant_checks=11 ack=98 sealed=98
[soak-runner] killer=seal-collision removed=10+3 kept=3+0 suffix_intact=true
 4 pass, 0 fail (18.18s)
```

```text
$ bash scripts/soak-runner.sh --seed 42
[soak-runner] seed=42 ops=200 invariant_checks=11 ack=86 sealed=86
[soak-runner] killer=seal-collision removed=10+3 kept=3+0 suffix_intact=true
soak-runner: PASS pass=2 fail=0 seed=42 steps=200 check_every=20
exit=0
```

11 checks per seed = 200/20 periodic + 1 final (after converge sync +
seal + sweep). `ack == sealed` at the end: the final seal covers the
fully drained log.

## limits (by design)

- Single device, `MemoryRelay` only: no multi-writer conflicts, no real
  sockets (those live in `soak.test.ts`, `stress-10.test.ts`).
- No `undo` op: the model tracks a grow-only live set; compensation
  paths are covered by `soak.test.ts`.
- Phase-2 (merge + tag) is never done by this script; the coordinator
  acts via its own inbox.
