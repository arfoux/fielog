// bench/bench-append.ts — measure local append throughput (append/sec).
// run: bun bench/bench-append.ts [N]   (default 5000)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { parseN, summarize } from './util.ts';

const N = parseN(process.argv, 5000);
const dir = mkdtempSync(join(tmpdir(), 'fielog-bench-append-'));
const kernel = await createKernel({ file: join(dir, 'bench.db') });

const per: number[] = [];
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const a = performance.now();
  await kernel.append({ type: 'bayar', nominal: 1000 + (i % 9000), oleh: 'bench' });
  per.push(performance.now() - a);
}
const secs = (performance.now() - t0) / 1000;
const rate = N / secs;
const s = summarize(per);
console.log(`append: n=${N} total_s=${secs.toFixed(2)} append_per_sec=${rate.toFixed(0)}`);
console.log(`append per-op ms: p50=${s.p50.toFixed(3)} p99=${s.p99.toFixed(3)} n=${s.n}`);
console.log(`RESULT ${JSON.stringify({ bench: 'append', n: N, total_s: secs, append_per_sec: rate, per_op_ms: s })}`);
kernel.close();
