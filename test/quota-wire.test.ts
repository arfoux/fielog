// quota-wire: byte quota enforced fail-closed on the kernel append path.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

describe('quota-wire: append past the byte ceiling is refused', () => {
  it('append exceeding quota throws ERR_QUOTA_EXCEEDED and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-quota-wire-'));
    const k = await createKernel({ file: join(dir, 'ledger.db'), quotaLimitBytes: 1, quotaEstimateBytes: 1 });
    closers.push(() => k.close());
    // db+log already exist (>1 byte), so even a 1-byte reservation denies.
    await assert.rejects(k.append({ type: 'entry', value: 1, actor: 'budi' }), /ERR_QUOTA_EXCEEDED/);
    assert.equal(k.health().events, 0);
  });

  it('append within quota succeeds and quota() reports headroom', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-quota-wire-ok-'));
    const k = await createKernel({ file: join(dir, 'ledger.db'), quotaLimitBytes: 100_000_000 });
    closers.push(() => k.close());
    const ev = await k.append({ type: 'entry', value: 1, actor: 'budi' });
    assert.equal(ev.seq, 1);
    const q = k.quota();
    assert.ok(q && q.limit === 100_000_000 && q.remaining > 0);
  });

  it('no quota configured: quota() is null and append is unbounded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-quota-wire-off-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    assert.equal(k.quota(), null);
    await k.append({ type: 'entry', value: 1, actor: 'budi' });
  });
});
