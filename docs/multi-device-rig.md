# multi-device-rig: device-01/device-02 rig -> convergence

The `scripts/two-device-rig.sh` script runs three two-device scenarios
through one memory relay (port of skill-11 multi-device-rig, HEALTHY).
Read-only reference: `test/two-device.test.js` (unmodified);
the rig scenarios live in `test/two-device-rig.test.ts`.

## Prerequisites

- base `main` = `d03e683` (`v0.14.13`); `bun test` green 88 pass / 0 fail.
- shell: `bash`, `git`, `bun`.

## Procedure

1. Full rig (default n 20):
   `bash scripts/two-device-rig.sh`
2. Rig with a different event count:
   `bash scripts/two-device-rig.sh --n 50`
3. One scenario only:
   `bash scripts/two-device-rig.sh --filter s2`
4. Number/hash/file claims ONLY from command output on this machine
   (mismatch-stop): claim != proof -> STOP, write a report, do not continue.

## Scenarios

| id | name | convergence evidence |
|---|---|---|
| s1 | device-01 sells offline, device-02 pulls until equal | both-side total = sum of n events; re-sync `applied=0` |
| s2 | two-way offline collision then converge | both-side total = combined sum of 10+10 events |
| s3 | relay drops mid-batch then resumes | `relay.size=n` (exact-once by uuid); device-02 total = sum of n events |

## Example output

```text
$ bash scripts/two-device-rig.sh
two-device-rig: n=20 filter=all
[two-device-rig] s1 total=147500 n=20 idempotent=ok
[two-device-rig] s2 total=59000 converged=ok
[two-device-rig] s3 total=20190 relay.size=20 resume=ok
two-device-rig: PASS pass=3 fail=0 n=20
```

s1 total = the sum of `5000 + i*250` for `i = 0..19` = 147500.
s2 total = the sum of `2000 + i*100` + `3000 + i*100` for `i = 0..9` = 59000.
s3 total = the sum of `1000 + i` for `i = 0..19` = 20190.

## Failure decision table

| condition | script signal | action |
|---|---|---|
| both-side totals differ | `AssertionError` in the scenario | STOP: check the sync order (s2 needs a second pull round); do not change expectations |
| duplicates after resume | `relay.size != n` | STOP: uuid dedupe broken; escalate, no manual retry |
| unknown flag / non-positive n | `error: ...` + exit 2 | fix the flag, retry |
| red tests | `RIG: FAIL pass=? fail=?` | fix in the rig file; `test/two-device.test.js` stays read-only |
