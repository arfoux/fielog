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

  it('voids a entry without deleting history', async () => {
    const first = await k.append({ type: 'entry', value: 50000, actor: 'budi' });
    await k.append({ type: 'entry', value: 25000, actor: 'ani' });
    const undo = await k.undo(first.id, 'budi');
    assert.equal(undo.type, 'undo.compensate');

    const rows = await k.query(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(rows[0].total, 25000);

    // Original line retained in the log and the store.
    const kept = await k.query(`SELECT COUNT(*) AS n FROM _events WHERE id = $id`, { id: first.id });
    assert.equal(kept[0].n, 1);
    const comp = await k.query(`SELECT COUNT(*) AS n FROM _events WHERE type = 'undo.compensate'`);
    assert.equal(comp[0].n, 1);
  });

  it('restores tally on remove undo', async () => {
    await k.append({ type: 'tally.add', payload: { item: 'WIDGET-01', qty: 10 } });
    const remove = await k.append({ type: 'tally.remove', payload: { item: 'WIDGET-01', qty: 4 } });
    await k.undo(remove.id);
    const rows = await k.query(`SELECT qty FROM tally WHERE item = 'WIDGET-01'`);
    assert.equal(rows[0].qty, 10);
  });
});
