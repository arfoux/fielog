// two-device-rig.test.ts — device-01/device-02 rig: three convergence scenarios,
// two devices through one relay (port of skill-11 multi-device-rig).
// read-only reference: test/two-device.test.js (left untouched).
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

const N = Number(process.env.RIG_N ?? 20);

async function total(k: Kernel): Promise<number> {
  const rows = await k.query<{ total: number }>(
    `SELECT SUM(amount) AS total FROM payment WHERE voided = 0`,
  );
  return rows[0]?.total ?? 0;
}

describe('two-device rig device-01/device-02', () => {
  let dir: string;
  let k1: Kernel;
  let k2: Kernel;
  let relay: MemoryRelay;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-rig-'));
    k1 = await createKernel({ file: join(dir, 'device-01.db'), deviceId: 'device-01' });
    k2 = await createKernel({ file: join(dir, 'device-02.db'), deviceId: 'device-02' });
    relay = new MemoryRelay();
  });
  afterEach(() => {
    k1?.close();
    k2?.close();
  });

  it('s1: device-01 sells offline, device-02 pulls until equal', async () => {
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const amount = 5000 + i * 250;
      expected += amount;
      await k1.append({ type: 'payment', amount, actor: 'device-01' });
    }
    await k1.sync(relay, { baseMs: 1 });
    const res = await k2.sync(relay, { baseMs: 1 });
    assert.equal(res.applied, N);
    assert.equal(await total(k1), expected);
    assert.equal(await total(k2), expected);
    const again = await k2.sync(relay, { baseMs: 1 });
    assert.equal(again.applied, 0);
    console.log(`[two-device-rig] s1 total=${expected} n=${N} idempotent=ok`);
  });

  it('s2: two-way offline collision then converge', async () => {
    let sum1 = 0;
    let sum2 = 0;
    for (let i = 0; i < 10; i++) {
      const a = 2000 + i * 100;
      const b = 3000 + i * 100;
      sum1 += a;
      sum2 += b;
      await k1.append({ type: 'payment', amount: a, actor: 'device-01' });
      await k2.append({ type: 'payment', amount: b, actor: 'device-02' });
    }
    const want = sum1 + sum2;
    await k1.sync(relay, { baseMs: 1 });
    await k2.sync(relay, { baseMs: 1 });
    await k1.sync(relay, { baseMs: 1 }); // pull the late-arriving device-02 batch
    assert.equal(await total(k1), want);
    assert.equal(await total(k2), want);
    console.log(`[two-device-rig] s2 total=${want} converged=ok`);
  });

  it('s3: cut mid-run then resume without duplicates', async () => {
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const amount = 1000 + i;
      expected += amount;
      await k1.append({ type: 'payment', amount, actor: 'device-01' });
    }
    relay.failAfterEvents = 7;
    await assert.rejects(k1.sync(relay, { chunkSize: 10, maxRetries: 0, baseMs: 1 }), /mid-batch/);
    relay.failAfterEvents = null;
    const res = await k1.sync(relay, { chunkSize: 10, baseMs: 1 });
    assert.equal(res.acked, N);
    assert.equal(relay.size, N); // exact-once by uuid even when push is retried
    await k2.sync(relay, { baseMs: 1 });
    assert.equal(await total(k2), expected);
    console.log(`[two-device-rig] s3 total=${expected} relay.size=${relay.size} resume=ok`);
  });
});
