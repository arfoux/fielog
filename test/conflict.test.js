// Conflicts are explicit rows for humans — never silent last-write-wins.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';

describe('conflict surfacing', () => {
  let dir;
  let k;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-conflict-'));
    k = await createKernel({ file: join(dir, 'kasir.db') });
  });
  afterEach(() => k?.close());

  it('double-sell beyond stock surfaces a conflict row', async () => {
    await k.append({ type: 'stock.add', payload: { item: 'beras', qty: 5 } });
    await k.append({ type: 'stock.sell', payload: { item: 'beras', qty: 4 } });
    await k.append({ type: 'stock.sell', payload: { item: 'beras', qty: 4 } }); // contended

    const conflicts = await k.conflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'oversell');

    // Stock never goes negative; the loser is parked, not applied.
    const stock = await k.query(`SELECT qty FROM stock WHERE item = 'beras'`);
    assert.equal(stock[0].qty, 1);
  });

  it('double-settle on money surfaces a conflict row', async () => {
    const pay = await k.append({ type: 'bayar', nominal: 90000, oleh: 'budi' });
    await k.settle(pay.id, 'settled', 'server');
    await k.settle(pay.id, 'settled', 'server'); // replayed/duplicated ack

    const states = await k.query(`SELECT state FROM bayar WHERE event_id = $id`, { id: pay.id });
    assert.equal(states[0].state, 'SETTLED_ONLINE'); // first write stands
    const conflicts = await k.conflicts();
    assert.ok(conflicts.some((c) => c.kind === 'double-settle'));
  });
});
