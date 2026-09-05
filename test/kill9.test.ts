// Kill -9 mid-append: the durable prefix survives, open repairs a torn
// tail, verify passes, totals match the log. Real SIGKILL, no mocks.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('kill9 recovery', () => {
  it('survives SIGKILL mid-append with zero corruption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-kill9-'));
    const proc = Bun.spawn(['bun', 'test/helpers/kill-child.ts', dir, '5000'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const logPath = join(dir, 'kasir.log');
    // Strike while appends are in flight: guaranteed mid-run kill.
    await waitFor(() => {
      try {
        return readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).length >= 50;
      } catch {
        return false;
      }
    });
    proc.kill('SIGKILL');
    await proc.exited;

    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const h = k.health();
      assert.ok(h.events >= 50, `expected durable prefix, got ${h.events}`);
      const v = k.verifyLog() as { ok: boolean; gaps?: number[] };
      assert.equal(v.ok, true);
      assert.deepEqual(v.gaps ?? [], []);

      // Totals equal the sum of every durable log line: nothing half-applied.
      let expected = 0;
      let lines = 0;
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const ev = JSON.parse(t);
        expected += Number(ev.payload.nominal);
        lines += 1;
      }
      assert.equal(lines, h.events);
      const rows = await k.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
      assert.equal(rows[0].total, expected);
    } finally {
      k.close();
    }
  }, 60_000);
});
