# quickstart

Two runnable patterns: one phone offline, then two phones syncing via relay.
Every snippet below runs as-is.

## 1 phone: write offline, read locally

```js
import { createKernel } from 'fielog';

const k = await createKernel({ file: 'kasir.db' });
await k.append({ type: 'bayar', nominal: 5000, oleh: 'kasir-1' });
const rows = await k.query('SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0');
console.log(rows[0].total); // 5000 — IOU_RECORDED state, not settled
k.close();
```

No network at all: `append`/`query`/`undo` never touch the network
(`src/kernel.ts`). Offline money is always recorded as
`IOU_RECORDED`; `PAID_OFFLINE` / arbitrary `state` is rejected by `checkAppend`.

## 2 phones: sync later via a local relay (dev, unsigned)

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
console.log(t[0].total); // 5000 — moved via relay
c1.close();
c2.close();
hp1.close();
hp2.close();
server.kill();
```

The full 20-transaction example is in `demo/kasir-2hp.ts`
(run via `bun run demo`).

## 2 phones: signed mode (production)

Open relays are for local dev only. Production: serve registers each device's
pubkey, sync carries a capability token (`bin/fielog.ts`):

```sh
# one time only: mint the device key (standard PEM: PRIV PKCS#8, PUB SPKI)
openssl genpkey -algorithm ed25519 -out kasir.priv
openssl pkey -in kasir.priv -pubout -out kasir.pub
# terminal 1 — serve keeps running until Ctrl-C:
bun bin/fielog.ts serve --port 8091 --file ./relay.log --trust kasir=./kasir.pub
# terminal 2:
bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --key ./kasir.priv --as kasir
```

Or in code (`src/kernel.ts:capToken`, `src/relay.ts:WsRelayClientOpts`):

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

Next: [architecture](architecture.md) for the module map,
[cli](cli.md) for all flags, [auth](auth.md) for the signing model.
