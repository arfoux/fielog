// bench/bench-query.ts — query p50/p99 over a 100k-event read-model.
// run: bun bench/bench-query.ts [N]   (default 100000)
// workloads: full-table aggregate (SUM over payment) and indexed point lookup by seq.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { parseN, summarize } from './util.ts';

const N = parseN(process.argv, 100_000);
const ITERS = 200;
const WARMUP = 10;
const dir = mkdtempSync(join(tmpdir(), 'fielog-bench-query-'));
const kernel = await createKernel({ file: join(dir, 'bench.db'), maxPending: N + 1000 });

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  await kernel.append({ type: 'payment', amount: 1000 + (i % 9000), actor: 'bench' });
  if ((i + 1) % 10_000 === 0) console.log(`build: ${i + 1}/${N}`);
}
console.log(`build: ${N} events in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

async function measure(label: string, fn: (i: number) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const a = performance.now();
    await fn(i);
    samples.push(performance.now() - a);
  }
  const s = summarize(samples);
  console.log(`query ${label}: p50_ms=${s.p50.toFixed(3)} p99_ms=${s.p99.toFixed(3)} n=${s.n}`);
  console.log(`RESULT ${JSON.stringify({ bench: 'query', workload: label, n_events: N, ...s })}`);
}

await measure('sum_all', () =>
  kernel.query(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`),
);
await measure('point_by_seq', (i) =>
  kernel.query(`SELECT * FROM payment WHERE seq = ?`, [(i * 7919) % N + 1]),
);
kernel.close();
