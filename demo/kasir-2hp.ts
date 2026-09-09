// demo/kasir-2hp.ts — run: bun demo/kasir-2hp.ts
// Two terminals, one relay: hp1 sells 20x fully offline, then both sync
// and prove identical totals on both sides.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, WsRelayServer, WsRelayClient } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'kasir-2hp-'));
const server = new WsRelayServer({ port: 8091, file: join(dir, 'relay.log') });
await server.start();
console.log(`relay at ${dir} port 8091`);

const hp1 = await createKernel({ file: join(dir, 'hp1.db') });
const hp2 = await createKernel({ file: join(dir, 'hp2.db') });

// 20 offline transactions on hp1: no network at all.
let expected = 0;
for (let i = 0; i < 20; i++) {
  const nominal = 5000 + i * 250;
  expected += nominal;
  await hp1.append({ type: 'bayar', nominal, oleh: 'kasir-1' });
}
const t1off = await hp1.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
const t2off = await hp2.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
console.log('offline: hp1 =', t1off[0].total, '| hp2 =', t2off[0].total ?? 0);

// Two-sided sync through the local ws relay.
const c1 = new WsRelayClient('ws://127.0.0.1:8091');
const c2 = new WsRelayClient('ws://127.0.0.1:8091');
await hp1.sync(c1);
await hp2.sync(c2);
const t1 = await hp1.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
const t2 = await hp2.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
console.log('sync:    hp1 =', t1[0].total, '| hp2 =', t2[0].total);
if (t1[0].total !== expected || t2[0].total !== expected) {
  throw new Error(`totals differ: hp1=${t1[0].total} hp2=${t2[0].total} expected=${expected}`);
}
console.log('match on both sides. hp1 state:', (await hp1.query(`SELECT DISTINCT state FROM bayar`)).map((r) => r.state));

c1.close();
c2.close();
hp1.close();
hp2.close();
server.kill();
