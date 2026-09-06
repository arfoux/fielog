# completion protocol: worker final report

Every worker final report MUST follow the template in "report template".
A report missing a section, or with a claim the reviewer cannot re-run,
is REJECTED — no partial credit, fix and resend. Docs-only changes follow
the same template; section 3 states the subset run and why it suffices.

## mismatch-stop

Before any other work, the worker MUST confirm:

```
git rev-parse HEAD
git describe --tags --always --dirty
```

If HEAD is not the assigned base, or the test baseline does not match
the assigned numbers, STOP: send escalation with both command outputs,
do no further work. Assigned base/numbers live in the dispatch TASK
block, never from memory.

Commit rule: message lowercase ascii, no emoji, imperative
(`docs: add completion protocol`, not `Docs: Add ...`).

## report template

Copy the block below verbatim, fill every field. `n/a` is never valid;
if a field truly has no content, write `none` plus one-line reason.

```
## 1. base proof (exact command output)

  base expected : <full sha from TASK, e.g. a9a6b4134850d8e64096b386a951eb94a8ace466>
  rev-parse     : <paste full `git rev-parse HEAD` output>
  describe      : <paste full `git describe --tags --always --dirty` output>
  match         : yes/no (no -> stopped, see mismatch-stop)

## 2. changed files (file:lines, from git diff)

  <path>:<start>-<end> <one-line what+why>
  ...one row per touched hunk; new file -> path:1-<lastline> (new)

  stat proof  : <paste `git status --short` + `git diff --stat` output>

## 3. test numbers (before -> after)

  suite command : <exact command, e.g. `bun test`>
  before        : <pass>/<fail>/<files> @ <base sha12>
  after         : <pass>/<fail>/<files> @ <work sha12 or "uncommitted">
  subset (if full suite not rerun):
    command     : <exact command actually run>
    result      : <pass>/<fail>/<files>, <wall time>
    why subset  : <one line; docs-only still runs at least the fast subset>

## 4. verify commands (reviewer copy-paste)

  <exact command per line; every claim in sections 1-3 reproducible>
  e.g.
  git rev-parse HEAD && git describe --tags --always --dirty
  git status --short && git diff --stat
  bun test <paths...>

## 5. self-check (all must be yes)

  [ ] template sections 1-4 present, in order, no `n/a`
  [ ] every number pasteable from tool output, not from memory
  [ ] commit message (if any) lowercase ascii, no emoji
```

## reject reasons (non-exhaustive)

- base sha quoted short-only (`a9a6b41`) with no full `rev-parse` paste.
- `describe` missing (dirty flag is load-bearing: uncommitted work
  invalidates the numbers).
- file listed without `:lines` (reviewer cannot scope the diff).
- test numbers without the exact command, or "green" with no counts.
- after-numbers from a different base than section 1.
- verify command that does not reproduce a section 1-3 claim.

## example ACCEPTED (wave-1, real)

```
## 1. base proof (exact command output)

  base expected : a9a6b4134850d8e64096b386a951eb94a8ace466
  rev-parse     : a9a6b4134850d8e64096b386a951eb94a8ace466
  describe      : v0.14.1
  match         : yes

## 2. changed files (file:lines, from git diff)

  (none — verification-only wave; no source touched)
  stat proof  : <empty `git status --short` output>

## 3. test numbers (before -> after)

  suite command : bun test
  before        : 66/0/28 @ a9a6b4134850 (assigned baseline)
  after         : 66/0/28 @ a9a6b4134850 (no source change; count
                  reconciles: 64 static `it` blocks + soak seed loop
                  1->3 fixed seeds + 1 unseeded = 66, across 28 files)
  subset (not used — full baseline attested by coordinator)

## 4. verify commands (reviewer copy-paste)

  git rev-parse HEAD && git describe --tags --always --dirty
  git status --short && git diff --stat
  grep -rE "^\s*it\(|^\s*it\." test/ --include="*.ts" --include="*.js" | wc -l
  grep -n "FIXED_SEEDS = " test/soak.test.ts

## 5. self-check (all must be yes)

  [x] template sections 1-4 present, in order, no `n/a`
  [x] every number pasteable from tool output, not from memory
  [x] commit message (if any) lowercase ascii, no emoji
```

Why it passes: full sha pasted (not short-only), clean `describe`
proves no uncommitted drift, test count reconciled to tool output
(static grep 64 + seed expansion math, both re-runnable via
section 4), every claim has a reviewer command.

## example REJECTED (annotated)

```
## 1. base proof

  base : a9a6b41            # REJECT: short-only, no rev-parse paste,
                           # no describe -> dirty state unknown

## 2. changed files

  src/sync.ts (fixed bug)  # REJECT: no :lines, no what-line scope,
                           # no stat proof

## 3. test numbers

  before: green            # REJECT: no counts, no command
  after : 67/0             # REJECT: no /files, no sha, no command;
                           # +1 vs 66 unexplained (new test? renamed?)

## 4. verify commands

  bun test                 # REJECT: bare command timed out past 300s on
                           # soak/model-fuzz here; no subset scoping, so the
                           # reviewer cannot reproduce the claimed numbers
```

Four rejects, four fixes: paste full sha + describe; scope files to
`:lines` + stat; counts with commands and sha context; verify commands
that actually reproduce the numbers (subset + wall time + why).
