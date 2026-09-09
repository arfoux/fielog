<p align="center">
  <img src="docs/gifs/logo.svg" alt="fielog logo — ledger slip with verification stamp" width="128">
</p>

# fielog — Fieldlog

Write anywhere, settle later.

Offline-first primitives for apps that must survive bank-down, blank-spot,
blackout: append-only log (source of truth) + SQLite read-model + sync-later.

```js
import { createKernel } from 'fielog';

const k = await createKernel({ file: 'ledger.db' });
await k.append({ type: 'payment', amount: 5000, actor: 'device-01' });
const rows = await k.query('SELECT SUM(amount) AS total FROM payment WHERE voided = 0');
console.log(rows[0].total); // 5000 — IOU_RECORDED, not settled
k.close();
```

Offline money is always recorded as `IOU_RECORDED`; settlement needs an online
ack. `append`/`query`/`undo` never touch the network — only `sync` does.

## Getting started

- [install](docs/install.md) — requirements (`bun` >= 1.0), setup, files created
- [quickstart](docs/quickstart.md) — 1 phone offline, 2 phones syncing (dev + signed mode), runnable
- [cli](docs/cli.md) — `serve` / `sync` / `demo`, every flag verified against `bin/fielog.ts`
- Real examples: `demo/two-node.ts` (`bun run demo`), `example/ledger.mjs` (`bun example/ledger.mjs`)

## Gallery

| | |
|---|---|
| <img src="docs/gifs/part1-log.png" alt="hash chain" width="480"><br>hash chain — every append seals to the previous entry | <img src="docs/gifs/part2-sync.png" alt="delta sync" width="480"><br>delta sync — only the diff flies, resuming from the last ack |
| <img src="docs/gifs/part3-relay.png" alt="relay" width="480"><br>relay — blind phones exchange messages via the server | <img src="docs/gifs/part4-retain.png" alt="snapshot+truncate" width="480"><br>snapshot+truncate — trim the log without losing the trail |
| <img src="docs/gifs/part5-auth.png" alt="capability+revoke" width="480"><br>capability+revoke — signed tokens, ruthless revocation | <img src="docs/gifs/part6-quarantine.png" alt="quarantine" width="480"><br>quarantine — corrupt entries jailed, never silently dropped |
| <img src="docs/gifs/part7-readmodel.png" alt="read model" width="480"><br>read model — SQLite rebuilt from the log | <img src="docs/gifs/part8-tombstone.png" alt="soft delete" width="480"><br>soft delete — delete = tombstone, history stays intact |

## Concepts & architecture

- [architecture](docs/architecture.md) — module map: log/store/kernel/sync/relay/cas/retain
- [contracts](docs/contracts.md) — binding promises: dead-letter, blind compensators,
  seal<=ack, device.explicit, incremental purge, deterministic jitter, v0.5 superset
- [kernel-api](docs/kernel-api.md) — `createKernel`, `Kernel`, `LogEvent`, `EventStore`
- [sync-protocol](docs/sync-protocol.md) — push/pull, failover, backoff, deltasync
- [relay](docs/relay.md) — `WsRelayServer` + `WsRelayClient`
- [retention](docs/retention.md) — snapshot + truncate
- [auth](docs/auth.md) — device key, grant, capability token, countersign, revoke

## Subsystems (deep dives)

- token: [capability-token](docs/capability-token.md) · revoke:
  [revoke-handshake](docs/revoke-handshake.md),
  [revoke-event-log](docs/revoke-event-log.md) — regrouped in [auth](docs/auth.md)
- delta-sync: [delta-sync](docs/delta-sync.md) · hash chain:
  [hash-chain-log](docs/hash-chain-log.md) · quarantine: [quarantine](docs/quarantine.md)
- attachments: [cas-store](docs/cas-store.md) · soft-delete:
  [tombstone-engine](docs/tombstone-engine.md) · quota: [quota-guard](docs/quota-guard.md)
- rig & harness: [multi-device-rig](docs/multi-device-rig.md),
  [corpus-generator](docs/corpus-generator.md),
  [corruption-generator](docs/corruption-generator.md),
  [cold-drill](docs/cold-drill.md), [soak-runner](docs/soak-runner.md),
  [chaos-kill](docs/chaos-kill.md), [flake-hunter](docs/flake-hunter.md),
  [conformance-gate](docs/conformance-gate.md), [watchdog](docs/watchdog.md),
  [mismatch-stop](docs/mismatch-stop.md), [completion-protocol](docs/completion-protocol.md),
  [merge-runner](docs/merge-runner.md), [model-oracle](docs/model-oracle.md),
  [compat-vectors](docs/compat-vectors.md), [decision-log](docs/decision-log.md)

## Numbers, limits, contributing

- Benchmark: [bench](docs/bench.md) (measured 2026-09-05) —
  smoke 2026-09-09: `bun bench/bench-append.ts 200` →
  **314 appends/sec, p50 2.94 ms, p99 6.76 ms**.
  Re-run via `bun run bench:append | bench:query | bench:sync`.
- Log compat: [compat](docs/compat.md) · changelog: [CHANGELOG](CHANGELOG.md)
- Limits + troubleshooting: [limits-troubleshooting](docs/limits-troubleshooting.md)
- Contributing: [CONTRIBUTING](CONTRIBUTING.md) · security: [SECURITY](SECURITY.md) ·
  conduct: [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md)

CLI serve/sync default to signed mode: serve needs `--trust <id=pub.pem>`
(repeat per device), sync needs `--key <priv.pem> --as <device>`.
`--unsigned` open relay is for local dev only, not production.
