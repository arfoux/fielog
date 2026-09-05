// Offline kasir flow: 80 transactions appended with NO relay/network,
// totals served from the local read-model, money stuck at IOU_RECORDED.
import { describe, it, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

describe('offline kasir flow', () => {
  let dir;
  let k;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-kasir-'));
    k = await createKernel({ file: join(dir, 'kasir.db') });
  });
  afterAll(() => k?.close());

  it('appends 80 tx offline and queries totals locally', async () => {
    let expected = 0;
    for (let i = 0; i < 80; i++) {
      const nominal = 10000 + i * 500;
      expected += nominal;
      await k.append({ type: 'bayar', nominal, oleh: `kasir-${i % 3}` });
    }
    const rows = await k.query(`SELECT SUM(nominal) AS total, COUNT(*) AS n FROM bayar WHERE voided = 0`);
    assert.equal(rows[0].n, 80);
    assert.equal(rows[0].total, expected);
  });

  it('money stays IOU_RECORDED — never paid offline', async () => {
    const states = await k.query(`SELECT DISTINCT state FROM bayar`);
    assert.deepEqual(states.map((r) => r.state), ['IOU_RECORDED']);
  });

  it('rejects PAID_OFFLINE outright', async () => {
    await assert.rejects(
      k.append({ type: 'bayar', payload: { nominal: 50000, oleh: 'x', state: 'PAID_OFFLINE' } }),
      /cannot be recorded offline/,
    );
  });

  it('log is 80 JSONL lines with a valid hash chain', async () => {
    const lines = readFileSync(k.logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 80);
    for (const line of lines) {
      const ev = JSON.parse(line);
      assert.ok(ev.id && ev.hash && ev.prev_hash);
    }
    assert.deepEqual(k.verifyLog(), { ok: true });
  });
});
