# merge-runner: ff-only merge spin -> main

The `scripts/merge-spin.sh` script merges one spin branch into `main`
without a merge commit, only when every gate is green. Exact tag `v0.14.N`
with `N = 2 + merge-order`; the order (`--order`) is coordinated via the
coordinator inbox so two runners never claim the same N.

## Prerequisites

- base `main` = `a9a6b41` (`v0.14.1`); `bun test` green 66 pass / 0 fail.
- `bun:sqlite` only in `src/store.ts`, `src/retain.ts` (mismatch-stop).
- shell: `bash`, `git`, `bun`. `shellcheck` if present (not required on the runner).

## Procedure

1. Claim an order: ask for `--order k` via the coordinator inbox, get `N = 2+k`.
2. Dry-run from your own worktree (touches neither `main`, branches, nor tags):
   `bash scripts/merge-spin.sh --spin <branch> --order <k> --dry-run`
3. On `DRY-RUN OK`, report to the coordinator: commit hash, test numbers,
   dry-run log. WAIT for phase-2.
4. Phase-2 ONLY via the coordinator inbox (which holds `main`):
   `git checkout main && bash scripts/merge-spin.sh --spin <branch> --order <k>`
   then `git push origin main v0.14.N`.
5. NEVER merge into `main` yourself from a dispatch worktree.

## Example output

dry-run (worktree `w2-merge-runner`, spin `w2-watchdog` 1 commit ahead of
`main`, `--order 0` -> tag `v0.14.2`):

```text
$ bash scripts/merge-spin.sh --spin w2-watchdog --order 0 --dry-run
merge-runner: spin=w2-watchdog order=0 tag=v0.14.2 dry_run=1
merge-runner: base=fecf5eb branch=w2-merge-runner
merge-runner: tag v0.14.2 free
merge-runner: PRE bun test on main ...
merge-runner: PRE green ( 66 pass  0 fail )
DRY-RUN OK: would run: git merge --ff-only w2-watchdog && bun test && git tag v0.14.2
DRY-RUN OK: no branch, tag, or working tree was mutated
```

real run (phase-2, on the coordinator's `main` checkout):

```text
$ git checkout main && bash scripts/merge-spin.sh --spin w2-watchdog --order 0
merge-runner: spin=w2-watchdog order=0 tag=v0.14.2 dry_run=0
merge-runner: base=a9a6b41 branch=main
merge-runner: tag v0.14.2 free
merge-runner: PRE bun test on main ...
merge-runner: PRE green ( 66 pass  0 fail )
Updating a9a6b41..e3f5a1b
Fast-forward
merge-runner: POST bun test on merged main ...
merge-runner: POST green ( 66 pass  0 fail )
merge-runner: DONE merged w2-watchdog -> main, tagged v0.14.2
```

## Failure decision table

| condition | script signal | action |
|---|---|---|
| not on `main` (real mode) | `REJECT: not on main` | `git checkout main`, retry |
| dirty tree (including untracked) | `REJECT: dirty working tree` | commit/stash (`-u`), retry |
| spin branch missing | `REJECT: spin branch ... does not exist` | fix the name / fetch |
| not fast-forward | `REJECT: non-fast-forward` | rebase the spin onto `main` in the spin worktree, request a fresh dry-run; the script NEVER merge-commits |
| nothing to merge | `REJECT: nothing to merge` | spin is already in `main`; abort, the order claim is void |
| tag `v0.14.N` exists | `REJECT: tag ... already exists` | order `k` is taken; re-coordinate via inbox |
| PRE `bun test` red | `REJECT: PRE bun test red` | merge ABORTED; fix on the spin branch, not on `main` |
| POST `bun test` red | `REJECT: POST bun test red ... UNTAGGED` | `main` is merged but UNTAGGED; STOP, escalate to the coordinator before tagging/manual revert |
| tag format violated | `error: generated tag ... violates exact format` | script bug; do not tag manually, escalate |

## Design notes

- `--ff-only` is used in two layers: a `merge-base --is-ancestor` check up
  front (clear rejection message) plus the `git merge --ff-only` flag at
  execution (anti-race if `main` moves mid-flight).
- Tags are created ONLY after a green POST; a red `main` never gets a tag.
- `set -euo pipefail`; syntax check: `bash -n scripts/merge-spin.sh`.
