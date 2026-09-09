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
`README.md`, `LICENSE`, `CHANGELOG.md`, `docs`.

## Try

From a repo checkout:

```sh
bun bin/fielog.ts demo
```

`demo` runs a two-node offline demo, then signed-mode sync, proving both sides
converge to the same records (`bin/fielog.ts:cmdDemo`).

`createKernel({ file: 'app.db' })` creates two files (`src/kernel.ts:logPathFor`):

| file | contents |
|---|---|
| `app.db` | SQLite read-model, opens in DBeaver |
| `app.log` | JSONL append-only, `tail -f` friendly, fsync per append |

The basename is yours — ledger-domain examples use `ledger.db` / `ledger.log`.
Both must be backed up / moved together. See [retention](retention.md)
for snapshot + truncate.

Next: [quickstart](quickstart.md).
