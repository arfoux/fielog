// Undo appends a compensating event: totals move, history stays.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

describe('undo compensating event', () => {
  let dir;
  let k;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-undo-'));
    k = await createKernel({ file: join(dir, 'ledger.db') });
  });
  afterEach(() => k?.close());

  it('voids a payment without deleting history', async () => {
    const first = await k.append({ type: 'payment', amount: 50000, actor: 'budi' });
    await k.append({ type: 'payment', amount: 25000, actor: 'ani' });
    const undo = await k.undo(first.id, 'budi');
    assert.equal(undo.type, 'undo.compensate');

    const rows = await k.query(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
    assert.equal(rows[0].total, 25000);

    // Original line retained in the log and the store.
    const kept = await k.query(`SELECT COUNT(*) AS n FROM _events WHERE id = $id`, { id: first.id });
    assert.equal(kept[0].n, 1);
    const comp = await k.query(`SELECT COUNT(*) AS n FROM _events WHERE type = 'undo.compensate'`);
    assert.equal(comp[0].n, 1);
  });

  it('restores stock on sell undo', async () => {
    await k.append({ type: 'stock.add', payload: { item: 'kopi', qty: 10 } });
    const sell = await k.append({ type: 'stock.sell', payload: { item: 'kopi', qty: 4 } });
    await k.undo(sell.id);
    const rows = await k.query(`SELECT qty FROM stock WHERE item = 'kopi'`);
    assert.equal(rows[0].qty, 10);
  });
});
