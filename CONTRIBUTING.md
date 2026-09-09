# Contributing

## Setup

```sh
bun install
bun test            # full suite (218 tests when this doc was written)
bun run build       # typecheck via tsc -p tsconfig.json
bun bin/fielog.ts demo   # end-to-end smoke: 2-node roundtrip
```

Requires: `bun` >= 1.0 (see [docs/install](docs/install.md)).

## Workflow

1. Read [docs/architecture](docs/architecture.md) + [docs/contracts](docs/contracts.md)
   before touching `src/` — the contracts there are binding.
2. Change code + the test pinning its behavior (one behavior = one test).
   New doc claims must point at code file:line.
3. `bun test` on touched files first; full suite + `bun run build`
   before the PR.
4. Small commits, clear messages (`<area>: <what + why>`).
   Write a CHANGELOG entry under `Unreleased` for user-visible changes.
5. PR: describe before/after behavior + run evidence
   (paste the relevant test/bench output). No run evidence = not ready for review.

## Style

- Boring first: existing patterns beat new ones. One convention per file.
- Fix the source, not the symptom: never silence warnings/exceptions or
  special-case input unless asked.
- No central formatter/linter — follow the style of the file you touch.
- Forbidden: stub/placeholder/`TODO: implement` as "done";
  invented perf numbers (write only what you measured — see
  [docs/bench](docs/bench.md)); doc links you did not click-verify.

## Not accepted

- Contract changes ([docs/contracts](docs/contracts.md)) without prior
  discussion in an issue.
- New log fields that break the superset rule ([docs/compat](docs/compat.md)).
- Tests that lock incidental wording/implementation — test behavior,
  not plumbing (see the verification rules in the parent repo if any).
