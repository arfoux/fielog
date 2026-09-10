# install

How to install fielog and its runtime requirements.

## Requirements

- `bun` >= 1.0 is required at runtime. The reason is concrete, not taste:
  `src/store.ts` uses `bun:sqlite`, `src/relay.ts` uses `Bun.serve`.
  Plain Node has neither.
- TypeScript is optional (only for `bun run build` via `tsc -p tsconfig.json`).

## Install

The `fielog` package is not published on the npm registry yet — `bun add fielog` /
`npm i fielog` 404s today. Until then, use a repo checkout:
the runtime needs nothing installed besides `bun` itself
(zero `dependencies`). `bun install` in the checkout is only needed for
devDeps (`tsc` for `bun run build`).

What ships on publish (`files` in `package.json`): `src`, `bin`,
`README.md`, `LICENSE`, `CHANGELOG.md`.

## Try

From a repo checkout:

Two different demos — same totals, disjoint auth regimes, neither leaves
state a later stage can pick up:

```sh
bun run demo              # = demo/two-node.ts: UNSIGNED dev demo (fixed port 8091)
bun bin/fielog.ts demo    # = bin/fielog.ts:cmdDemo: SIGNED demo (ephemeral port, minted keys + cap tokens)
```

Both seed 20 offline entries on device-01, sync two sides, and prove
identical totals. Both write to a fresh temp dir and kill the relay at
exit — nothing survives for a later `serve`/`sync` to continue from.
Unsigned rows carry no signatures, so a signed-mode pull dead-letters
them: there is no unsigned→signed upgrade step. Pick one regime per task
and start fresh; production is always the signed path
(`serve --trust` + `sync --key/--as`, see [quickstart](quickstart.md)).

`createKernel({ file: 'app.db' })` creates two files (`src/kernel.ts:logPathFor`):

| file | contents |
|---|---|
| `app.db` | SQLite read-model, opens in DBeaver |
| `app.log` | JSONL append-only, `tail -f` friendly, fsync per append |

The basename is yours — ledger-domain examples use `ledger.db` / `ledger.log`.
Both must be backed up / moved together. See [retention](retention.md)
for snapshot + truncate.

Next: [quickstart](quickstart.md).
