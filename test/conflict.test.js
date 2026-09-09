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
    k = await createKernel({ file: join(dir, 'ledger.db') });
  });
  afterEach(() => k?.close());

  it('double-remove beyond tally surfaces a conflict row', async () => {
    await k.append({ type: 'tally.add', payload: { item: 'beras', qty: 5 } });
    await k.append({ type: 'tally.remove', payload: { item: 'beras', qty: 4 } });
    await k.append({ type: 'tally.remove', payload: { item: 'beras', qty: 4 } }); // contended

    const conflicts = await k.conflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'underflow');

    // Tally never goes negative; the loser is parked, not applied.
    const tally = await k.query(`SELECT qty FROM tally WHERE item = 'beras'`);
    assert.equal(tally[0].qty, 1);
  });

  it('double-resolve on money surfaces a conflict row', async () => {
    const pay = await k.append({ type: 'entry', value: 90000, actor: 'budi' });
    await k.resolve(pay.id, 'resolved', 'server');
    await k.resolve(pay.id, 'resolved', 'server'); // replayed/duplicated ack

    const states = await k.query(`SELECT state FROM entries WHERE event_id = $id`, { id: pay.id });
    assert.equal(states[0].state, 'RESOLVED_ONLINE'); // first write stands
    const conflicts = await k.conflicts();
    assert.ok(conflicts.some((c) => c.kind === 'double-resolve'));
  });
});
