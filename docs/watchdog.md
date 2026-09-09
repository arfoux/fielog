# watchdog supervisor

Port of skill-24 (`watchdog-supervisor`, status SOLID) to fielog.
One script polls one orchestration wave and wakes the coordinator on
three conditions: `worker_done`, `escalation`, or `timeout`.

Related field skills: 46 (`portabilitas-watchdog`, state dir via
`TEMP`, never hardcoded `/tmp`), 37 (`disiplin-false-alarm`, the
script reports raw state, the coordinator judges), 65
(`daemon-gabungan`, exit-code convention 0/2/3 source).

## usage

```sh
scripts/watchdog.sh --run <run_id> [--tasks id1,id2,...]
  [--interval <sec>] [--timeout <sec>] [--once] [--from-json <file>]
```

| flag | default | meaning |
| --- | --- | --- |
| `--run` | - | orchestration run to poll (required unless `--from-json`) |
| `--tasks` | all | comma-separated task ids to watch; empty = whole run |
| `--interval` | 30 | seconds between polls |
| `--timeout` | 900 | per-wave deadline in seconds; past it the wave is declared timed out |
| `--once` | off | single poll, no loop (dry-run, cron, doc examples) |
| `--from-json` | - | read a canned `task-list --json` capture instead of calling orca (dry-run/tests) |

The script is read-only: it only calls `orca orchestration task-list`.
It never dispatches, updates, or stops anything, so it is safe to run
against a live run and safe to aim at runs owned by other coordinators
for inspection (writes stay forbidden regardless).

Requirements: `orca` and `bun` on `PATH` (`bun` parses the JSON state).
State dir resolves as `${TMPDIR:-${TEMP:-${TMP:-/tmp}}}` so the script
survives Windows hosts without `/tmp`.

## wake criteria

Each round the script counts watched tasks as `done` (`completed` with
`outcome == succeeded`), `failed` (`completed` with any other outcome),
or `open` (any other status). First match wins:

1. `failed` non-empty -> `WAKE-COORDINATOR reason=escalation`, exit 3.
   A worker reporting failure needs coordinator eyes now, not at deadline.
2. all watched tasks `done` -> `WAKE-COORDINATOR reason=worker_done`, exit 0.
   Wave is finished; coordinator proceeds to merge + tag (fase-2).
3. elapsed >= `--timeout` -> `WAKE-COORDINATOR reason=timeout`, exit 2.
   Lists the still-open `id(status)` pairs so the coordinator knows who
   to check (`worker-read`, re-dispatch, or stand down).

## exit codes

| code | meaning | coordinator action |
| --- | --- | --- |
| 0 | wave complete, all `worker_done` arrived | merge + tag |
| 2 | timeout, tasks still open (or single `--once` poll with open tasks) | inspect open workers, decide retry/stand-down |
| 3 | escalation, a task completed with `outcome != succeeded` | read failure report immediately |
| 1 | usage/environment error (bad flags, `orca`/`bun` missing, state unreadable) | fix invocation, not the wave |

## example session: wave-1 of run_881f9ef2d48a

Run created 2026-09-05T22:40:40Z, three read-only recon workers:

| task | worker | completed_at |
| --- | --- | --- |
| `[moltarc-audit-pattern]` task_f2ab2d2f4b27 | term_... | 2026-09-05 22:46:12 |
| `[spin-spec-decompose]` task_6594cf77f3f7 | term_... | 2026-09-05 22:46:19 |
| `[fielog-baseline-map]` task_c933171ea8b6 | term_... | 2026-09-05 22:48:54 |

A supervisor with `--interval 60 --timeout 900` would log two quiet
rounds, then on the third poll see 3/3 done and wake the coordinator:

```text
[watchdog 22:44:01] round=1 watched=3 done=0 open=[...(dispatched)...] elapsed=0s - sleeping 60s
[watchdog 22:47:05] round=2 watched=3 done=2 open=[task_c933171ea8b6(running)] elapsed=184s - sleeping 60s
[watchdog 22:49:10] round=3 watched=3 done=3 elapsed=309s
[watchdog 22:49:10] WAKE-COORDINATOR reason=worker_done run=run_881f9ef2d48a all=3/3
```

Replayed live on 2026-09-06 (single poll, same three ids):

```text
$ sh scripts/watchdog.sh --run run_881f9ef2d48a \
    --tasks task_c933171ea8b6,task_6594cf77f3f7,task_f2ab2d2f4b27 --once
[watchdog 06:09:16] round=1 watched=3 done=3 elapsed=2s
[watchdog 06:09:17] WAKE-COORDINATOR reason=worker_done run=run_881f9ef2d48a all=3/3
exit=0
```

No wake for escalation or timeout was needed: the wave finished clean
in ~8 minutes (22:41 dispatch -> 22:48:54 last done), inside the 900 s
budget. That matches the skill-24 proof note ("evidence: one proof per wave").

## dry-run record (2026-09-06, fixtures from live state)

Fixtures were cut from a real `task-list --run run_881f9ef2d48a --json`
capture (`$TEMP/wd-live.json`, 12 tasks) and fed via `--from-json`.
No live run was touched.

A. one completed task -> exit 0:

```text
$ sh scripts/watchdog.sh --from-json $TEMP/wd-done.json --once
[watchdog 06:09:06] round=1 watched=1 done=1 elapsed=1s
[watchdog 06:09:06] WAKE-COORDINATOR reason=worker_done run=from-json all=1/1
exit=0
```

B. timeout simulation, one open task with `--timeout 0` -> exit 2:

```text
$ sh scripts/watchdog.sh --from-json $TEMP/wd-timeout.json --timeout 0 --interval 1
[watchdog 06:09:10] round=1 watched=1 done=0 open=[task_8fd06ee3a695(ready)] elapsed=1s timeout=0s
[watchdog 06:09:10] WAKE-COORDINATOR reason=timeout run=from-json open=[task_8fd06ee3a695(ready)]
exit=2
```

C. escalation, one task with `outcome=failed` -> exit 3:

```text
$ sh scripts/watchdog.sh --from-json $TEMP/wd-failed.json --once
[watchdog 06:09:11] round=1 watched=1 done=1 open=[]
[watchdog 06:09:11] WAKE-COORDINATOR reason=escalation failed=[task_sim_failed(failed)] run=from-json
exit=3
```

## limits (by design)

- Verdicts are raw state, not judgement (skill-37): `timeout` means
  "deadline passed with tasks open", not "workers are stuck". The
  coordinator verifies with `worker-read` before acting.
- Escalation detection covers task `outcome`; free-text coordinator
  inbox escalations are out of scope for this script.
- Phase-2 (merge + tag) is never done by the watchdog; it only wakes
  the coordinator, which acts via its own inbox.
