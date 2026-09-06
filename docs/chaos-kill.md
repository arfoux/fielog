# chaos-kill drill

Port of skill-2 (`chaos-kill`, status MANTAP) to fielog. Real `SIGKILL`
at three points — write, seal, sync — then reopen, verify, continue.
No mocks: a child process dies mid-operation and the parent proves
the durable prefix survives.

Skill-text note: the skill body is not present in this worktree
(`grep -r MANTAP` hits only `docs/watchdog.md`, the skill-24 port),
so the dispatch task block is the spec: SIGKILL at X (tulis, seal,
sync) plus recovery proof (reopen + verify + lanjut). Minimal
adaptation, no invented skill content.

Related: `test/kill9.test.ts` (reference, read-only — kill mid-append);
this drill extends it to seal and sync.

## usage

```sh
scripts/chaos-kill.sh
```

Runs `bun test test/chaos-kill.test.ts test/kill9.test.ts`, prints the
tail counts, exits non-zero on any failure. Exit codes: `0` all green,
`1` drill failed, `2` environment error (`bun` missing).

## kill points and what the code guarantees

| point | child does | mechanism that saves it |
| --- | --- | --- |
| write | `append` loop, killed after >= 50 lines | `fsync` per append (`src/log.ts:235-236`): everything before the kill is durable; a torn tail is truncated on open (`src/log.ts:184-191`); reopen replays the log idempotently by UUID (`src/kernel.ts:114-118`) |
| seal | `append` + `sync` + `snapshot` + `truncate` loop, killed after the first marker lands | sweep writes marker + kept lines to a new file, `fsync`s, then atomically renames (`src/retain.ts:145-154`) — never in-place; the seal is clamped to acked-and-stored rows (`src/retain.ts:74-93`, `src/kernel.ts:184-190`); the marker re-anchors `verify` (`src/log.ts:262`) |
| sync | 500 appends, then a sync loop, killed ~300 ms in | the ack cursor persists in sqlite meta, so resume starts after the last acked chunk; re-push is exact-once by UUID (same guarantee as `test/sync-resume.test.js`) |

## recovery proof (each case)

1. reopen with `createKernel` on the same files;
2. `verifyLog()` returns `{ ok: true }` with zero gaps;
3. read-model totals equal the durable log (write/sync), or sealed
   prefix + kept suffix (seal);
4. continue: append (and seal/sync again), counts grow, verify stays green.

## measured run (2026-09-06, this worktree, base `0bb7803` = `v0.14.6`)

```text
$ bun test test/chaos-kill.test.ts
 3 pass
 0 fail
Ran 3 tests across 1 file. [13.95s]
```

```text
$ sh scripts/chaos-kill.sh   # chaos-kill + kill9 reference
bun test v1.4.0 (34cbb9a40)

 4 pass
 0 fail
Ran 4 tests across 2 files. [12.42s]
[chaos-kill] exit=0
```
Preconditions, measured before writing: `git rev-parse HEAD` =
`0bb7803af27265d7042f8121b19b711ce81a3284` (matches dispatch base
`0bb7803`); `git describe --tags HEAD` = `v0.14.6`; worktree was clean
(`git status --short` empty) at start. Base full-suite, first
measurement (`bun test 2>&1 | tail -6`, backgrounded before this
drill's files existed, 28 files): `65 pass, 1 fail, 459.16s` — but
this drill's own `bun test` runs overlapped that window
(fsync-heavy children beside the suite), so the failure read as
contention, not base. Clean rerun with nothing else running
(`bun test`, full output to file): `69 pass, 0 fail, 29 files,
326.69s, exit=0` — 66 base tests green plus this drill's 3.
Base-green 66/0 confirmed; the 1 fail does not reproduce.

## limits (by design)

- One kill per case, at one timing each: the sweep rename and the
  fsync window are covered by mechanism (atomic rename, per-append
  fsync), not by exhaustive timing.
- The seal case waits for the first marker before killing, so it
  proves "kill after a seal", not "kill inside the rename syscall".
- Fase-2 (merge + tag) is never done here; this worker only commits
  on its own branch.
