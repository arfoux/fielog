// Stale-relay pull miss: syncWithFailover kept one shared pull cursor and
// read only the first healthy relay, so a stale replica first in list order
// hid the suffix living on fresher replicas (success status, events missed).
// Regression: per-relay cursors + fan-out pull across every healthy relay.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

const fast = { baseMs: 1, maxMs: 30 };

describe('stale-relay pull miss', () => {
  it('suffix living only on the second relay is applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-stalerelay-'));
    const stale = new MemoryRelay();
    const fresh = new MemoryRelay();
    const seed = await createKernel({ file: join(dir, 'seed.db') });
    try {
      for (let i = 0; i < 5; i++) await seed.append({ type: 'payment', amount: 1000 + i, actor: 'toko' });
      const up = await seed.sync(fresh, { ...fast });
      assert.equal(up.acked, 5);
      assert.equal(fresh.size, 5);
      assert.equal(stale.size, 0);
    } finally {
      seed.close();
    }
    const reader = await createKernel({ file: join(dir, 'reader.db') });
    try {
      const down = await reader.sync([stale, fresh], { ...fast });
      assert.equal(down.pulled, 5);
      assert.equal(down.applied, 5);
      const rows = await reader.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment WHERE voided = 0`);
      assert.equal(rows[0].n, 5);
      // Resume is exact-once: nothing new, nothing duplicated.
      const again = await reader.sync([stale, fresh], { ...fast });
      assert.equal(again.applied, 0);
      const rows2 = await reader.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment WHERE voided = 0`);
      assert.equal(rows2[0].n, 5);
    } finally {
      reader.close();
    }
  }, 30_000);

  it('split replicas converge: stale prefix + fresh suffix both land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-stalerelay-split-'));
    const stale = new MemoryRelay();
    const fresh = new MemoryRelay();
    const seed = await createKernel({ file: join(dir, 'seed.db') });
    try {
      await seed.append({ type: 'payment', amount: 100, actor: 'toko' });
      await seed.append({ type: 'payment', amount: 200, actor: 'toko' });
      await seed.sync(stale, { ...fast });
      await seed.append({ type: 'payment', amount: 300, actor: 'toko' });
      await seed.sync(fresh, { ...fast });
      assert.equal(stale.size, 2);
      assert.equal(fresh.size, 1); // delta only: seq 1-2 already acked via stale
    } finally {
      seed.close();
    }
    const reader = await createKernel({ file: join(dir, 'reader.db') });
    try {
      const down = await reader.sync([stale, fresh], { ...fast });
      assert.equal(down.applied, 3);
      const rows = await reader.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
      assert.equal(rows[0].total, 600);
    } finally {
      reader.close();
    }
  }, 30_000);
});
