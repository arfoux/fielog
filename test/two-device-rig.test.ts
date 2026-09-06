// two-device-rig.test.ts — rig kasir-01/kasir-02: tiga skenario konvergensi
// dua device lewat satu relay (port of skill-11 multi-device-rig).
// read-only reference: test/two-device.test.js (tidak diubah).
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
    `SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`,
  );
  return rows[0]?.total ?? 0;
}

describe('two-device rig kasir-01/kasir-02', () => {
  let dir: string;
  let k1: Kernel;
  let k2: Kernel;
  let relay: MemoryRelay;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-rig-'));
    k1 = await createKernel({ file: join(dir, 'kasir-01.db'), deviceId: 'kasir-01' });
    k2 = await createKernel({ file: join(dir, 'kasir-02.db'), deviceId: 'kasir-02' });
    relay = new MemoryRelay();
  });
  afterEach(() => {
    k1?.close();
    k2?.close();
  });

  it('s1: kasir-01 jualan offline, kasir-02 tarik sampai sama', async () => {
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const nominal = 5000 + i * 250;
      expected += nominal;
      await k1.append({ type: 'bayar', nominal, oleh: 'kasir-01' });
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

  it('s2: dua arah tabrakan offline lalu konvergen', async () => {
    let sum1 = 0;
    let sum2 = 0;
    for (let i = 0; i < 10; i++) {
      const a = 2000 + i * 100;
      const b = 3000 + i * 100;
      sum1 += a;
      sum2 += b;
      await k1.append({ type: 'bayar', nominal: a, oleh: 'kasir-01' });
      await k2.append({ type: 'bayar', nominal: b, oleh: 'kasir-02' });
    }
    const want = sum1 + sum2;
    await k1.sync(relay, { baseMs: 1 });
    await k2.sync(relay, { baseMs: 1 });
    await k1.sync(relay, { baseMs: 1 }); // tarik batch kasir-02 yang datang belakangan
    assert.equal(await total(k1), want);
    assert.equal(await total(k2), want);
    console.log(`[two-device-rig] s2 total=${want} konvergen=ok`);
  });

  it('s3: putus tengah jalan lalu resume tanpa duplikat', async () => {
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const nominal = 1000 + i;
      expected += nominal;
      await k1.append({ type: 'bayar', nominal, oleh: 'kasir-01' });
    }
    relay.failAfterEvents = 7;
    await assert.rejects(k1.sync(relay, { chunkSize: 10, maxRetries: 0, baseMs: 1 }), /mid-batch/);
    relay.failAfterEvents = null;
    const res = await k1.sync(relay, { chunkSize: 10, baseMs: 1 });
    assert.equal(res.acked, N);
    assert.equal(relay.size, N); // exact-once by uuid walau push diulang
    await k2.sync(relay, { baseMs: 1 });
    assert.equal(await total(k2), expected);
    console.log(`[two-device-rig] s3 total=${expected} relay.size=${relay.size} resume=ok`);
  });
});
