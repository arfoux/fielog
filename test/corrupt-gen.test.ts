// corrupt-gen detector: each fault mode is caught on reopen by the
// kernel health/verify surface. real files, no mocks. sibling of
// test/corrupt.test.ts (single hand-made fault, read-only here).
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { bitflip, tornTail, truncateTail } from '../scripts/corrupt-gen.ts';

const N = 10;

async function seed(dir: string): Promise<{ file: string; logPath: string }> {
  const file = join(dir, 'kasir.db');
  const k = await createKernel({ file });
  for (let i = 0; i < N; i++) {
    await k.append({ type: 'bayar', nominal: 1000 + i, oleh: 'budi' });
  }
  const logPath = k.logPath;
  k.close();
  return { file, logPath };
}

describe('corrupt-gen detector', () => {
  it('bitflip mid-file quarantines one line and re-anchors the gap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-corruptgen-bitflip-'));
    const { file, logPath } = await seed(dir);
    const info = bitflip(logPath, 5);
    assert.equal(info.before, '"');
    assert.equal(info.after, '#');

    const k = await createKernel({ file });
    try {
      const h = k.health();
      assert.equal(h.events, N - 1);
      assert.equal(h.quarantined, 1);
      assert.deepEqual(h.gaps, [6]);
      assert.equal(k.verifyLog().ok, true);
      const q = readFileSync(logPath + '.quarantine', 'utf8').trim().split('\n');
      assert.equal(q.length, 1);
    } finally {
      k.close();
    }
  }, 30_000);

  it('torn tail truncates on open and flags repairedtail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-corruptgen-torn-'));
    const { file, logPath } = await seed(dir);
    tornTail(logPath);

    const k = await createKernel({ file });
    try {
      const h = k.health();
      assert.equal(h.repairedTail, true);
      assert.equal(h.events, N - 1);
      assert.equal(k.verifyLog().ok, true);
    } finally {
      k.close();
    }
  }, 30_000);

  it('truncate drops the suffix but keeps the prefix valid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-corruptgen-trunc-'));
    const { file, logPath } = await seed(dir);
    const info = truncateTail(logPath, 2);
    assert.equal(info.kept, N - 2);

    const k = await createKernel({ file });
    try {
      const h = k.health();
      assert.equal(h.events, N - 2);
      assert.equal(h.quarantined, 0);
      assert.equal(h.repairedTail, false);
      assert.equal(k.verifyLog().ok, true);
      const rows = await k.query<{ total: number }>(
        `SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`,
      );
      let expected = 0;
      for (let i = 0; i < N - 2; i++) expected += 1000 + i;
      assert.equal(rows[0].total, expected);
    } finally {
      k.close();
    }
  }, 30_000);
});
