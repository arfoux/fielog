# cold-drill (fielog adaptation)

Port of skill-8 (`cold-drill`, status SOLID) to fielog WITH ADAPTATIONS.
The original: delete everything except the cold tier, prove the node revives
from the cold tier alone. fielog has no cold tier (wave-1 fact) — the only
source of truth is the primary log (`ledger.log`, hash-chained JSONL).
This drill deletes everything EXCEPT the primary log and proves the node
revives from the log alone via replay + verify.

## Deleted vs kept

| file | fate | reason |
|---|---|---|
| `ledger.log` (primary log) | KEPT | the only source of truth |
| `ledger.db` + `-wal`/`-shm`/`-journal` (sqlite read-model) | DELETED | derived: rebuilt via replay |
| `ledger.snapshot.db` (retain snapshot) | DELETED | derived: read-model copy + seal |
| `ledger.log.quarantine` (corrupt-line forensics) | DELETED | derived: recreated when the corrupt log is re-read |

Revival mechanism (`src/kernel.ts`, `createKernel`): `openLog` reads
`ledger.log`, `store.replay` rebuilds sqlite idempotently per
UUID, then `verify` checks the hash chain. The test uses deterministic
value `1000+i` (`i = 0..n-1`), so the expected total

## Adaptation limits vs the original

1. No cross-tier fetch is tested — there is no tier. What is tested is
   pure local replay, not a cold fetch from remote storage.
2. Sqlite meta is lost too: `device.id` (script + test use an explicit
   deviceId to stay stable), ack cursors (the next sync re-pushes from
   seq 0 — safe because pushes are idempotent per UUID, but with duplicate
   sends; there is no cursor re-seed step, so expect a full duplicate-send
   storm on first sync), and `snapshot.sealed_seq` (snapshot seal lost —
   re-`snapshot` + `truncate` from scratch after revive).
3. Quarantine forensics are deleted too: the history of once-quarantined
   corrupt lines does not survive — the remaining log is still re-verified,
   and named gaps (`gaps`) appear when lines are missing.
4. A once-swept log stays safe: the `fielog-truncate` marker is the first
   line of `ledger.log` itself, so it is kept.

## Usage

```sh
bash scripts/cold-drill.sh [--n <events>] [--dir <path>] [--keep-dir]
```

| flag | default | meaning |
|---|---|---|
| `--n` | 50 | number of deterministic seeded `entry` events |
| `--dir` | fresh tmp | drill directory (created via `mktemp` in `${TMPDIR:-${TEMP:-${TMP:-/tmp}}}`) |
| `--keep-dir` | delete | keep the drill directory for inspection |

The script only reads/writes its own drill directory; it never touches the
network, relays, or repo files. Exit code 0 on `DRILL: PASS`
(events + total + verify identical before/after), 1 on `DRILL: FAIL`
or usage/environment errors.

## Run evidence (2026-09-06, this machine)

```
BEFORE events=50 total=51225 expected=51225 verify=ok
log lines=50 bytes=15984 (want lines=50)
before delete: ledger.db ledger.db-shm ledger.db-wal ledger.log
after delete: ledger.log
AFTER events=50 total=51225 expected=51225 verify=ok gaps=[]
DRILL: PASS (n=50, replay from ledger.log only, totals identical, verify ok)
```

proof command: `bash scripts/cold-drill.sh --n 50`
automated test: `bun test test/cold-drill.test.ts` → `1 pass, 0 fail`
(same scenario in-process: seed 30 events, keep only `ledger.log`,
reopen, assert identical events + total + verify).

Phase-2 (merge + tag) only via coordinator inbox instruction.
