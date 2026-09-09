// One corrupt log line: open skips it into quarantine, verify names the
// gap instead of dying, sync ships the healthy events. Reopen is stable.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

describe('corrupt line quarantine', () => {
  it('skips, quarantines, syncs, and stays stable on reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-corrupt-'));
    const file = join(dir, 'ledger.db');
    const k1 = await createKernel({ file });
    let expected10 = 0;
    for (let i = 0; i < 10; i++) {
      expected10 += 1000 + i;
      await k1.append({ type: 'payment', amount: 1000 + i, actor: 'budi' });
    }
    const logPath = k1.logPath;
    k1.close();

    // Bitrot line 5 (seq 5).
    const lines = readFileSync(logPath, 'utf8').split('\n');
    lines[4] = '{"type":"payment","amount":BROKEN';
    writeFileSync(logPath, lines.join('\n'));

    const k2 = await createKernel({ file }); // must not throw
    try {
      const h = k2.health();
      assert.equal(h.events, 9);
      assert.equal(h.quarantined, 1);
      assert.deepEqual(h.gaps, [6]); // seq 6 re-anchored after the gap
      const v = k2.verifyLog();
      assert.equal(v.ok, true);

      const rows = await k2.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
      assert.equal(rows[0].total, expected10 - 1004);

      assert.ok(existsSync(logPath + '.quarantine'));
      const q = readFileSync(logPath + '.quarantine', 'utf8').trim().split('\n');
      assert.equal(q.length, 1);

      // Sync ships only the healthy events and completes.
      const relay = new MemoryRelay();
      const res = await k2.sync(relay, { chunkSize: 4, baseMs: 1, maxMs: 30 });
      assert.equal(res.acked, 9);
      assert.equal(relay.size, 9);
    } finally {
      k2.close();
    }

    // Reopen: quarantine stays exactly one entry, health identical.
    const k3 = await createKernel({ file });
    try {
      assert.equal(k3.health().quarantined, 1);
      assert.deepEqual(k3.health().gaps, [6]);
      const q = readFileSync(logPath + '.quarantine', 'utf8').trim().split('\n');
      assert.equal(q.length, 1);
    } finally {
      k3.close();
    }
  }, 30_000);
});
