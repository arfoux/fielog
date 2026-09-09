// Poison-event pull: one bad write on the relay must not brick sync.
// The relay stores verbatim (dumb by design), so the pull side skips
// dead-letters before they touch the local log and still advances the
// pull cursor past them. Regression: sync used to throw, pollute the log
// with the poison UUID, and duplicate it on every retry forever.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import type { LogEvent } from '../src/log.ts';

const fast = { baseMs: 1, maxMs: 30 };

describe('poison pull', () => {
  it('skips dead-letters, advances the cursor, keeps syncing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-poison-'));
    const relay = new MemoryRelay();
    const good1: LogEvent = { id: 'good-1', seq: 1, type: 'payment', actor: 'budi', device_id: 'devA', ts_device: 1, payload: { amount: 1000, actor: 'budi' }, prev_hash: 'GENESIS', hash: 'h1' };
    const poison: LogEvent = { id: 'poison-1', seq: 2, type: 'payment', actor: 'mallory', device_id: 'mallory-dev', ts_device: 2, payload: { amount: -999 }, prev_hash: 'h1', hash: 'h2' };
    const untyped: LogEvent = { id: 'untyped-1', seq: 3, type: '', actor: 'mallory', device_id: 'mallory-dev', ts_device: 3, payload: {}, prev_hash: 'h2', hash: 'h3' };
    const good2: LogEvent = { id: 'good-2', seq: 4, type: 'payment', actor: 'budi', device_id: 'devA', ts_device: 4, payload: { amount: 2000, actor: 'budi' }, prev_hash: 'h3', hash: 'h4' };
    await relay.push([good1, poison, untyped, good2]);

    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.pulled, 4);
      assert.equal(res.applied, 2); // only the valid events land

      // Poison never touches the local log or the read-model.
      const lines = readFileSync(k.logPath, 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines.length, 2);
      assert.ok(!readFileSync(k.logPath, 'utf8').includes('poison-1'));
      assert.ok(!readFileSync(k.logPath, 'utf8').includes('untyped-1'));
      const rows = await k.query<{ event_id: string; amount: number }>(`SELECT event_id, amount FROM payment ORDER BY amount`);
      assert.deepEqual(rows.map((r) => r.event_id), ['good-1', 'good-2']);

      // Cursor advanced past the poison: the next sync is a no-op delta,
      // not a retry storm, and no duplicate UUID lines appear.
      const res2 = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res2.pulled, 0);
      assert.equal(res2.applied, 0);
      const lines2 = readFileSync(k.logPath, 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines2.length, 2);

      // Sync keeps working after poison: new valid events still flow.
      const good3: LogEvent = { id: 'good-3', seq: 5, type: 'payment', actor: 'budi', device_id: 'devA', ts_device: 5, payload: { amount: 3000, actor: 'budi' }, prev_hash: 'h4', hash: 'h5' };
      await relay.push([good3]);
      const res3 = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res3.applied, 1);
      assert.deepEqual(k.verifyLog(), { ok: true });
    } finally {
      k.close();
    }
  }, 30_000);
});
