// demo/two-node.ts — run: bun demo/two-node.ts
// Two nodes, one relay: device-01 sells 20x fully offline, then both sync
// and prove identical totals on both sides.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, WsRelayServer, WsRelayClient } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'two-node-'));
const server = new WsRelayServer({ port: 8091, file: join(dir, 'relay.log') });
await server.start();
console.log(`relay at ${dir} port 8091`);

const node1 = await createKernel({ file: join(dir, 'device-01.db') });
const node2 = await createKernel({ file: join(dir, 'device-02.db') });

// 20 offline transactions on device-01: no network at all.
let expected = 0;
for (let i = 0; i < 20; i++) {
  const value = 5000 + i * 250;
  expected += value;
  await node1.append({ type: 'entry', value, actor: 'device-01' });
}
const t1off = await node1.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
const t2off = await node2.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
console.log('offline: device-01 =', t1off[0].total, '| device-02 =', t2off[0].total ?? 0);

// Two-sided sync through the local ws relay.
const c1 = new WsRelayClient('ws://127.0.0.1:8091');
const c2 = new WsRelayClient('ws://127.0.0.1:8091');
await node1.sync(c1);
await node2.sync(c2);
const t1 = await node1.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
const t2 = await node2.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
console.log('sync:    device-01 =', t1[0].total, '| device-02 =', t2[0].total);
if (t1[0].total !== expected || t2[0].total !== expected) {
  throw new Error(`totals differ: device-01=${t1[0].total} device-02=${t2[0].total} expected=${expected}`);
}
console.log('match on both sides. device-01 state:', (await node1.query(`SELECT DISTINCT state FROM entries`)).map((r) => r.state));

c1.close();
c2.close();
node1.close();
node2.close();
server.kill();
