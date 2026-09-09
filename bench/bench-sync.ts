// bench/bench-sync.ts — sync throughput (events/sec) over a real ws relay.
// run: bun bench/bench-sync.ts [N]   (default 10000)
// device A appends N events, pushes to the relay; fresh device B pulls them.
// chunkSize 500; correctness checked by comparing SUM(value) on both sides.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';
import { parseN } from './util.ts';

const N = parseN(process.argv, 10_000);
const CHUNK = 500;
const fast = { baseMs: 1, maxMs: 30 };
const dir = mkdtempSync(join(tmpdir(), 'fielog-bench-sync-'));
const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log') });
const port = await server.start();

const ka = await createKernel({ file: join(dir, 'a.db') });
let expected = 0;
for (let i = 0; i < N; i++) {
  const value = 1000 + (i % 9000);
  expected += value;
  await ka.append({ type: 'entry', value, actor: 'bench' });
}

const ca = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast });
const tPush = performance.now();
const up = await ka.sync(ca, { chunkSize: CHUNK, ...fast });
const pushSecs = (performance.now() - tPush) / 1000;

const kb = await createKernel({ file: join(dir, 'b.db') });
const cb = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast });
const tPull = performance.now();
const down = await kb.sync(cb, { chunkSize: CHUNK, ...fast });
const pullSecs = (performance.now() - tPull) / 1000;

const rows = await kb.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
if (rows[0].total !== expected) throw new Error(`total mismatch: got=${rows[0].total} want=${expected}`);
if (down.applied !== N) throw new Error(`applied mismatch: got=${down.applied} want=${N}`);

const e2e = N / (pushSecs + pullSecs);
console.log(`sync push: n=${N} acked=${up.acked} secs=${pushSecs.toFixed(2)} events_per_sec=${(N / pushSecs).toFixed(0)}`);
console.log(`sync pull: n=${N} applied=${down.applied} secs=${pullSecs.toFixed(2)} events_per_sec=${(N / pullSecs).toFixed(0)}`);
console.log(`sync e2e: events_per_sec=${e2e.toFixed(0)}`);
console.log(
  `RESULT ${JSON.stringify({ bench: 'sync', n: N, chunk: CHUNK, push_s: pushSecs, push_per_sec: N / pushSecs, pull_s: pullSecs, pull_per_sec: N / pullSecs, e2e_per_sec: e2e })}`,
);
ca.close();
cb.close();
ka.close();
kb.close();
server.kill();
