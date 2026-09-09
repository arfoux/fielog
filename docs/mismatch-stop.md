# mismatch-stop

Recursive rule: every number/hash/file/tag claim MUST be proven with a command
before use. Claim != proof -> STOP, write a report, do not continue.
This rule applies to itself: verify your work preconditions up front
(see "self-verification" below).

## Preconditions per spin kind

| spin | precondition | proof command | passes when |
|---|---|---|---|
| test-count | green suite with the base-matching pass count | `bun test 2>&1 \| tail -4` | `pass 66, fail 0` on base `a9a6b41` |
| base-hash | HEAD equals the requested base | `git rev-parse HEAD` | prefix fully matches the base hash (`a9a6b41...`) |
| file-scope | work ONLY in this dispatch worktree, only task files | `pwd` + `git status --short` | cwd = dispatch worktree, no modifications outside scope |
| tag-format | lowercase ascii commit without emoji; tag `vX.Y.Z` | `git log -1 --format=%s` + `git tag \| tail -3` | no capitals / non-ascii / emoji; tag matches `v[0-9]*` |

Quick check of everything before starting work:

```
git rev-parse HEAD          # base-hash
bun test 2>&1 | tail -4     # test-count (wait for it to finish, do not tail and leave)
pwd; git status --short     # file-scope
git log -1 --format=%s      # tag-format (for the commit you are about to make)
```

A single failed precondition -> STOP. No "continue first, prove later".

## STOP report format

Every STOP must carry these three columns, no exceptions:

| column | contents |
|---|---|
| claim | what was stated (number/hash/file/tag + its source: who, when) |
| actual | what was measured on this machine |
| proof command | the exact command producing the actual column (copy-pasteable) |

Template:

```
STOP: <spin kind>
claim:   <value> (source: <dispatch/task/commitment>)
actual:  <measured value>
proof:    <exact command>
```

## Real wave-1 examples

### 1. test-count: 66-vs-64

```
STOP: test-count
claim:   66 pass, 0 fail (source: wave-1 base status)
actual:  64 pass, 0 fail
proof:    bun test 2>&1 | tail -4
```

2 tests missing: the suite did not fail, but the pass count differs from the
claim. That is still a mismatch — STOP, not "almost green". The cause then:
two test files did not run in that worktree.

### 2. base-hash: 219cc96-vs-3aa0492

```
STOP: base-hash
claim:   base 219cc96 (source: wave-1 dispatch brief)
actual:  HEAD 3aa0492
proof:    git rev-parse HEAD
```

The worktree stands on the wrong commit. All verification on the wrong base
is void for that task — STOP, switch/match the base first, then start working.

## Self-verification (dispatch w2-mismatch-stop)

This document's work preconditions, measured before/during writing:

```
base-hash proof:
  command: git rev-parse HEAD
  actual:   a9a6b4134850d8e64096b386a951eb94a8ace466
  matches base a9a6b41 -> PASS

file-scope proof:
  command: pwd; git status --short
  actual:   C:/Users/HP/orca/workspaces/fielog/w2-mismatch-stop, clean
  only touches docs/mismatch-stop.md -> PASS

test-count proof:
  command: bun test 2>&1 | tail -4
  actual:   66 pass, 0 fail, 28 files, 300.31s
  matches green-base claim 66/0 -> PASS
```
