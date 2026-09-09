# corpus generator

Port of skill-10 (`corpus-generator`, status HEALTHY) to fielog.
One seeded function emits a fixed op mix — `entry` / `stock.add` /
`stock.sell` / `undo.compensate` — with deterministic ids, so the same
`(seed, n)` always yields byte-identical JSONL. The corpus feeds soak,
fuzz, and model-oracle spins without re-inventing a generator per spin.

Related field skills: 37 (`disiplin-false-alarm`, the script reports raw
counts, the coordinator judges), shared `Oracle` lives in
`scripts/model-oracle.ts` (canonical copy, never inlined).

## usage

```sh
bun scripts/corpus-gen.ts [--seed N] [--n N] [--out DIR]
```

| flag | default | meaning |
| --- | --- | --- |
| `--seed` | 42 (`$CORPUS_SEED`) | rng seed; same seed + n = identical bytes |
| `--n` | 200 (`$CORPUS_N`) | events to emit |
| `--out` | `corpus` | output dir; writes `corpus-<seed>-<n>.jsonl` + `.manifest.json` |

Library use (tests import this, never shell out):

```ts
import { genCorpus, corpusSha, corpusManifest } from '../scripts/corpus-gen.ts';
const c = genCorpus(42, 200); // { seed, n, events }
corpusSha(c); // sha256 over canonical lines
```

Exit codes: 0 on write, 2 on usage error.

## ops

Seeded `mulberry32` picks one op per step (`known` non-empty after the
first event, so `undo` always has a target):

| op | share | effect |
| --- | --- | --- |
| `entry` | ~50% | value `100 + floor(rng()*4900)`, actor from `device-a/b/c` |
| `stock.add` | ~20% | item from `kopi/gula/beras`, qty 1..20 |
| `stock.sell` | ~15% | same items, qty 1..10 (oversell parks, oracle mirrors it) |
| `undo.compensate` | ~15% | `reverses` = random earlier corpus id (unknown/voided targets park) |

Ids are `corpus-<seed>-<i>` (deterministic, content-addressable). The
kernel strips caller ids on append (`src/kernel.ts`, `toAppendInput`),
so replay maps corpus id -> kernel UUID and drives the `Oracle` with
kernel ids; undo targets resolve through the same map.

## determinism contract

- Pure function: no IO, no clock, no `randomUUID` — `mulberry32` only.
- Canonical bytes: fixed key order (`id, type, payload, actor`), one
  JSON object per line, sha256 over the join.
- Test pins it: same seed twice = `deepEqual` + equal sha; seed 42 vs
  43 diverge; seed normalizes to uint32.

## Run evidence (2026-09-06, base d03e683 = v0.14.13)

```text
$ bun test test/corpus-gen.test.ts
[corpus-gen] determinism seed=42 n=200 sha=ca7311f769ba
[corpus-gen] replay seed=42 n=200 sha=ca7311f769ba entry=97 add=40 sell=27 undo=36 verify=ok
 4 pass, 0 fail (3.46s)
```

```text
$ bun scripts/corpus-gen.ts --seed 42 --n 200 --out /tmp/corpus-proof
[corpus-gen] seed=42 n=200 sha=ca7311f769ba entry=97 add=40 sell=27 undo=36
[corpus-gen] wrote corpus-42-200.jsonl + corpus-42-200.manifest.json
```

Replay (in-test, 200 events through `createKernel` + shared `Oracle` +
`checkOracle`): per-actor and stock balances match, `verifyLog` clean.

## limits (by design)

- Single device, offline ops only: no `sync`/`restart` interleaving
  (those live in `soak-runner`), no multi-writer conflicts.
- No `resolve`/`entry.*` ops: money-state transitions are covered by
  `model-oracle` / `model-fuzz`.
- Phase-2 (merge + tag) is never done by this script; the coordinator
  acts via its own inbox.
