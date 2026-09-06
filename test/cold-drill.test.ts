// Cold-drill (adapted): delete everything except the primary log, then rise
// from the log alone. fielog has no cold tier (wave-1 fact), so the drill
// keeps only kasir.log, removes the sqlite read-model + snapshots, and
// proves replay + verify rebuild identical state. Real files, no mocks.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

const N = 30;
const nominal = (i: number): number => 1000 + i;

describe('cold-drill from primary log only', () => {
  it('rebuilds identical state after deleting everything but kasir.log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cold-drill-'));
    const file = join(dir, 'kasir.db');
    const logPath = join(dir, 'kasir.log');

    const seed = await createKernel({ file, deviceId: 'cold-drill-test' });
    let expected = 0;
    try {
      for (let i = 0; i < N; i++) {
        expected += nominal(i);
        await seed.append({ type: 'bayar', nominal: nominal(i), oleh: 'cold-drill' });
      }
      assert.equal(seed.health().events, N);
      assert.equal(seed.verifyLog().ok, true);
      const before = await seed.query<{ total: number }>(
        'SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0',
      );
      assert.equal(before[0].total, expected);
    } finally {
      seed.close();
    }

    // Adaptasi: hapus semua KECUALI log primer.
    // Integration exception (timer rule): windows melepas handle sqlite
    // sesaat setelah close — penantian nyata pada jam platform, tak bisa
    // dikontrol dengan fake timer.
    const sleep = (ms: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    };
    for (const f of readdirSync(dir)) {
      if (f === 'kasir.log') continue;
      const target = join(dir, f);
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          rmSync(target, { recursive: true, force: true });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await sleep(100);
        }
      }
      if (lastErr) throw lastErr;
    }
    assert.deepEqual(readdirSync(dir), ['kasir.log']);
    assert.equal(
      readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).length,
      N,
    );

    // Bangkit dari log saja: replay + verify.
    const risen = await createKernel({ file, deviceId: 'cold-drill-test' });
    try {
      assert.equal(risen.health().events, N);
      const v = risen.verifyLog();
      assert.equal(v.ok, true);
      assert.deepEqual(v.gaps ?? [], []);
      const after = await risen.query<{ total: number }>(
        'SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0',
      );
      assert.equal(after[0].total, expected);
    } finally {
      risen.close();
    }
  }, 30_000);
});
