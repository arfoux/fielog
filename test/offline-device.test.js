// Offline device flow: 80 transactions appended with NO relay/network,
// totals served from the local read-model, entries stay RECORDED.
import { describe, it, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

describe('offline device flow', () => {
  let dir;
  let k;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-device-'));
    k = await createKernel({ file: join(dir, 'ledger.db') });
  });
  afterAll(() => k?.close());

  it('appends 80 tx offline and queries totals locally', async () => {
    let expected = 0;
    for (let i = 0; i < 80; i++) {
      const value = 10000 + i * 500;
      expected += value;
      await k.append({ type: 'entry', value, actor: `device-${i % 3}` });
    }
    const rows = await k.query(`SELECT SUM(value) AS total, COUNT(*) AS n FROM entries WHERE voided = 0`);
    assert.equal(rows[0].n, 80);
    assert.equal(rows[0].total, expected);
  });

  it('entries stay RECORDED — never resolved offline', async () => {
    const states = await k.query(`SELECT DISTINCT state FROM entries`);
    assert.deepEqual(states.map((r) => r.state), ['RECORDED']);
  });

  it('rejects RESOLVED_OFFLINE outright', async () => {
    await assert.rejects(
      k.append({ type: 'entry', payload: { value: 50000, actor: 'x', state: 'RESOLVED_OFFLINE' } }),
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
