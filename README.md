# fielog — Fieldlog

Write anywhere, settle later.

Offline-first primitives for apps that must survive bank-down, blank-spot,
blackout: append-only log (source of truth) + SQLite read-model + sync-later.

## Install

```sh
bun add fielog
# or: npm i fielog
```

Requires `bun` (>= 1.0) at runtime — `kernel` and `WsRelayServer` use `bun:sqlite` and `Bun.serve`.
CLI: `bunx fielog demo` or `bun bin/fielog.ts demo`.
CLI serve/sync default mode tanda: serve butuh `--trust <id=pub.pem>`
(ulang per device), sync butuh `--key <priv.pem> --as <device>`.
`--unsigned` relay terbuka hanya untuk dev lokal, bukan produksi.

## Quickstart

```js
import { createKernel } from 'fielog';

const k = await createKernel({ file: 'kasir.db' });
await k.append({ type: 'bayar', nominal: 5000, oleh: 'kasir-1' });
const rows = await k.query('SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0');
console.log(rows[0].total); // 5000
k.close();
```

Two devices, sync later via a relay (`demo/kasir-2hp.ts`, run with `bun run demo`):

```js
import { createKernel, WsRelayServer, WsRelayClient } from 'fielog';

const server = new WsRelayServer({ port: 8091, file: 'relay.log' });
await server.start();
const hp1 = await createKernel({ file: 'hp1.db' });
const hp2 = await createKernel({ file: 'hp2.db' });
await hp1.append({ type: 'bayar', nominal: 5000, oleh: 'kasir-1' });
await hp1.sync(new WsRelayClient('ws://127.0.0.1:8091'));
await hp2.sync(new WsRelayClient('ws://127.0.0.1:8091'));
```

## Docs

- benchmarks with measured numbers: [docs/bench.md](docs/bench.md), re-run via `bun run bench:append | bench:query | bench:sync` (scripts in [bench/](bench/))
- log compat guarantee: [docs/compat.md](docs/compat.md)
- changelog: [CHANGELOG.md](CHANGELOG.md)

## Core API (v0.12)

| fungsi | bentuk | janji |
|---|---|---|
| `append({type, ...isi} \| {type, payload})` | `Promise<LogEvent>` | tulis log + fsync, tanpa jaringan. `bayar` selalu `IOU_RECORDED`, `PAID_OFFLINE` ditolak |
| `query(sql, params?)` | `Promise<rows[]>` | baca sqlite lokal, tanpa jaringan. `kasir.db` bisa dibuka di dbeaver |
| `undo(id, actor?)` | `Promise<LogEvent>` | event kompensasi, riwayat tidak dihapus |
| `settle(id, 'settled' \| 'failed' \| 'expired')` | `Promise<LogEvent>` | `DRAFT → IOU_RECORDED → SETTLED_ONLINE \| FAILED \| EXPIRED` |
| `sync(relay, {chunkSize, maxRetries, baseMs, maxMs}?)` | `Promise<{pushed, acked, pulled, applied}>` | delta per `seq`, lanjut dari cursor ack, idempoten per UUID |
| `conflicts()` | `Promise<rows[]>` | baris konflik terbuka untuk rekonsiliasi manusia |
| `health()` | `{events, quarantined, repairedTail, gaps}` | kondisi log: baris korup, ekor robek, celah rantai |

Relay: `MemoryRelay` (in-memory, buat test) atau `WsRelayServer` +
`WsRelayClient` di `src/relay.ts` (bun serve, file-backed + fsync, reconnect
backoff, heartbeat, broadcast). Contoh kasir 2 hp di bawah bisa dicopy jalan
apa adanya — simpan sebagai `kasir-2hp.mjs` di root repo, lalu `bun kasir-2hp.mjs`:

```js
import { createKernel, WsRelayServer, WsRelayClient } from './src/index.ts';

const server = new WsRelayServer({ port: 8091, file: 'relay.log' });
await server.start();

const hp1 = await createKernel({ file: 'hp1.db' });
const hp2 = await createKernel({ file: 'hp2.db' });

// 20 transaksi offline di hp1: tanpa jaringan sama sekali.
for (let i = 0; i < 20; i++) {
  await hp1.append({ type: 'bayar', nominal: 5000 + i * 250, oleh: 'kasir-1' });
}
const show = async (k, nama) => {
  const r = await k.query('SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0');
  console.log(nama, '=', r[0].total ?? 0);
};
await show(hp1, 'offline hp1');
await show(hp2, 'offline hp2');

// Sync dua sisi lewat relay ws lokal.
const c1 = new WsRelayClient('ws://127.0.0.1:8091');
const c2 = new WsRelayClient('ws://127.0.0.1:8091');
await hp1.sync(c1);
await hp2.sync(c2);
await show(hp1, 'sync    hp1');
await show(hp2, 'sync    hp2');

c1.close();
c2.close();
hp1.close();
hp2.close();
server.kill();
```

(Blok di atas juga ada sebagai `demo/kasir-2hp.ts`, jalan via `bun run demo`.)
