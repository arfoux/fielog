// Two devices, one relay: pushed events pull down idempotently under
// fresh local seq, with origin preserved. Clocks untrusted: local order
// is (seq, device_id); server_time only arrives via ack.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

describe('two-device pull', () => {
  let dir;
  let a;
  let b;
  let relay;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-pull-'));
    a = await createKernel({ file: join(dir, 'a.db') });
    b = await createKernel({ file: join(dir, 'b.db') });
    relay = new MemoryRelay();
  });
  afterEach(() => {
    a?.close();
    b?.close();
  });

  it('pulls remote events once, under local seq', async () => {
    const tx = await a.append({ type: 'payment', amount: 77000, actor: 'budi' });
    await a.sync(relay, { baseMs: 1 });
    const res = await b.sync(relay, { baseMs: 1 });
    assert.equal(res.pulled, 1);
    assert.equal(res.applied, 1);

    const rows = await b.query(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
    assert.equal(rows[0].total, 77000);

    // Re-pull is a no-op: idempotent by UUID.
    const again = await b.sync(relay, { baseMs: 1 });
    assert.equal(again.applied, 0);
    const count = await b.query(`SELECT COUNT(*) AS n FROM payment`);
    assert.equal(count[0].n, 1);

    // Origin preserved, local seq assigned by the receiver.
    const ev = await b.query(`SELECT * FROM _events WHERE id = $id`, { id: tx.id });
    assert.equal(ev.length, 1);
    assert.notEqual(ev[0].device_id, undefined);
  });
});
