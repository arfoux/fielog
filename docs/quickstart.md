# quickstart

Two runnable patterns: one phone offline, then two phones syncing via relay.
Every snippet below runs as-is.

## 1 phone: write offline, read locally

```js
import { createKernel } from 'fielog';

const k = await createKernel({ file: 'ledger.db' });
await k.append({ type: 'payment', amount: 5000, actor: 'device-01' });
const rows = await k.query('SELECT SUM(amount) AS total FROM payment WHERE voided = 0');
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
const node1 = await createKernel({ file: 'device-01.db' });
const node2 = await createKernel({ file: 'device-02.db' });
await node1.append({ type: 'payment', amount: 5000, actor: 'device-01' });
const c1 = new WsRelayClient('ws://127.0.0.1:8091');
const c2 = new WsRelayClient('ws://127.0.0.1:8091');
await node1.sync(c1);
await node2.sync(c2);
const t = await node2.query('SELECT SUM(amount) AS total FROM payment WHERE voided = 0');
console.log(t[0].total); // 5000 — moved via relay
c1.close();
c2.close();
node1.close();
node2.close();
server.kill();
```

The full 20-transaction example is in `demo/two-node.ts`
(run via `bun run demo`).

## 2 phones: signed mode (production)

Open relays are for local dev only. Production: serve registers each device's
pubkey, sync carries a capability token (`bin/fielog.ts`):

```sh
# one time only: mint the device key (standard PEM: PRIV PKCS#8, PUB SPKI)
openssl genpkey -algorithm ed25519 -out device-01.priv
openssl pkey -in device-01.priv -pubout -out device-01.pub
# terminal 1 — serve keeps running until Ctrl-C:
bun bin/fielog.ts serve --port 8091 --file ./relay.log --trust device-01=./device-01.pub
# terminal 2:
bun bin/fielog.ts sync --file ./ledger.db --relay ws://127.0.0.1:8091 --key ./device-01.priv --as device-01
```

Or in code (`src/kernel.ts:capToken`, `src/relay.ts:WsRelayClientOpts`):

```js
import { createKernel, generateDeviceKey, WsRelayServer, WsRelayClient } from 'fielog';

const k1 = generateDeviceKey('device-01');
const server = new WsRelayServer({ port: 8091, file: 'relay.log',
  trustedDevices: { 'device-01': k1.publicKeyPem } });
await server.start();
const node1 = await createKernel({ file: 'device-01.db', deviceId: 'device-01', privateKeyPem: k1.privateKeyPem });
const c1 = new WsRelayClient('ws://127.0.0.1:8091', { capToken: node1.capToken(k1.privateKeyPem) });
await node1.sync(c1, { trustedDevices: { 'device-01': k1.publicKeyPem } });
c1.close();
node1.close();
server.kill();
```

Next: [architecture](architecture.md) for the module map,
[cli](cli.md) for all flags, [auth](auth.md) for the signing model.
