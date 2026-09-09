// Clock skew +30min on one device: materialized order still follows the
// monotonic seq, never the wall clock. ts_device is display only.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

const SKEW = 30 * 60 * 1000;

describe('clock skew', () => {
  it('orders by seq while wall clocks disagree by 30 minutes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-skew-'));
    const now = Date.now();
    const ka = await createKernel({ file: join(dir, 'a.db'), clock: () => now + SKEW });
    const kb = await createKernel({ file: join(dir, 'b.db') });
    const relay = new MemoryRelay();
    try {
      let expected = 0;
      for (let i = 0; i < 5; i++) {
        expected += 1000 + i;
        await ka.append({ type: 'payment', amount: 1000 + i, actor: 'skewed' });
      }
      await ka.sync(relay, { baseMs: 1, maxMs: 30 });
      await kb.sync(relay, { baseMs: 1, maxMs: 30 }); // pulls 5 future-stamped events
      await kb.append({ type: 'payment', amount: 50, actor: 'sane' }); // small ts, local seq 6
      expected += 50;
      const bySeq = await kb.query<{ seq: number; ts_device: number; amount: number }>(
        `SELECT e.seq, e.ts_device, b.amount FROM _events e LEFT JOIN payment b ON b.event_id = e.id ORDER BY e.seq`,
      );
      const byTs = await kb.query<{ seq: number }>(`SELECT seq FROM _events ORDER BY ts_device`);
      assert.equal(byTs[0].seq, 6);
      // Skew is really present in the stored stamps.
      assert.ok(bySeq[0].ts_device - bySeq[5].ts_device > SKEW - 60_000);

      const rows = await kb.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
      assert.equal(rows[0].total, expected);
    } finally {
      ka.close();
      kb.close();
    }
  }, 30_000);
});
