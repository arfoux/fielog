# quickstart

Dua pola runnable: satu HP offline, lalu dua HP sync via relay.
Semua cuplikan di bawah bisa dicopy jalan apa adanya.

## 1 HP: tulis offline, baca lokal

```js
import { createKernel } from 'fielog';

const k = await createKernel({ file: 'kasir.db' });
await k.append({ type: 'bayar', nominal: 5000, oleh: 'kasir-1' });
const rows = await k.query('SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0');
console.log(rows[0].total); // 5000 — state IOU_RECORDED, bukan lunas
k.close();
```

Tanpa jaringan sama sekali: `append`/`query`/`undo` tidak pernah menyentuh
network (`src/kernel.ts`). Uang offline selalu tercatat sebagai
`IOU_RECORDED`; `PAID_OFFLINE` / `state` sembarang ditolak `checkAppend`.

## 2 HP: sync nanti via relay lokal (dev, tanpa tanda)

```js
import { createKernel, WsRelayServer, WsRelayClient } from 'fielog';

const server = new WsRelayServer({ port: 8091, file: 'relay.log' });
await server.start();
const hp1 = await createKernel({ file: 'hp1.db' });
const hp2 = await createKernel({ file: 'hp2.db' });
await hp1.append({ type: 'bayar', nominal: 5000, oleh: 'kasir-1' });
const c1 = new WsRelayClient('ws://127.0.0.1:8091');
const c2 = new WsRelayClient('ws://127.0.0.1:8091');
await hp1.sync(c1);
await hp2.sync(c2);
const t = await hp2.query('SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0');
console.log(t[0].total); // 5000 — pindah via relay
c1.close();
c2.close();
hp1.close();
hp2.close();
server.kill();
```

Contoh lengkap 20 transaksi ada di `demo/kasir-2hp.ts`
(jalan via `bun run demo`).

## 2 HP: mode tanda (produksi)

Relay terbuka hanya untuk dev lokal. Produksi: serve mendaftarkan pubkey
tiap device, sync membawa token kapabilitas (`bin/fielog.ts`):

```sh
# sekali saja: lahirkan kunci device (PEM standar: PRIV PKCS#8, PUB SPKI)
openssl genpkey -algorithm ed25519 -out kasir.priv
openssl pkey -in kasir.priv -pubout -out kasir.pub
# terminal 1 — serve jalan terus sampai Ctrl-C:
bun bin/fielog.ts serve --port 8091 --file ./relay.log --trust kasir=./kasir.pub
# terminal 2:
bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --key ./kasir.priv --as kasir
```

Atau di kode (`src/kernel.ts:capToken`, `src/relay.ts:WsRelayClientOpts`):

```js
import { createKernel, generateDeviceKey, WsRelayServer, WsRelayClient } from 'fielog';

const k1 = generateDeviceKey('hp1');
const server = new WsRelayServer({ port: 8091, file: 'relay.log',
  trustedDevices: { hp1: k1.publicKeyPem } });
await server.start();
const hp1 = await createKernel({ file: 'hp1.db', deviceId: 'hp1', privateKeyPem: k1.privateKeyPem });
const c1 = new WsRelayClient('ws://127.0.0.1:8091', { capToken: hp1.capToken(k1.privateKeyPem) });
await hp1.sync(c1, { trustedDevices: { hp1: k1.publicKeyPem } });
c1.close();
hp1.close();
server.kill();
```

Lanjut: [arsitektur](architecture.md) untuk peta modul,
[cli](cli.md) untuk semua flag, [auth](auth.md) untuk model tanda.
