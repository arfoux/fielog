// Reorder resurrection: an undo/transition that arrives before its target
// parks (records / unknown-entry conflict) and must re-resolve when the
// target lands later. No stuck voided=0, no stuck IOU state, either order.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { hashFor, type LogEvent } from '../src/log.ts';

const fast = { baseMs: 1, maxMs: 30 };

function mkEv(o: {
  id: string; seq: number; type: string; actor?: string; deviceId?: string;
  ts: number; payload: Record<string, unknown>; prev: string;
}): LogEvent {
  const core = {
    id: o.id, seq: o.seq, type: o.type, actor: o.actor,
    device_id: o.deviceId ?? 'devA', ts_device: o.ts, payload: o.payload, prev_hash: o.prev,
  };
  return { ...core, hash: hashFor(core) };
}

describe('out-of-order resurrection', () => {
  it('undo before entry still voids when the target arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const pay = mkEv({
      id: 'pay-early-undo', seq: 2, type: 'entry', actor: 'budi',
      ts: 2, payload: { value: 75000, actor: 'budi' }, prev: 'h1',
    });
    const undo = mkEv({
      id: 'undo-early', seq: 1, type: 'undo.compensate', actor: 'budi',
      ts: 1, payload: { reverses: 'pay-early-undo' }, prev: 'GENESIS',
    });
    const relay = new MemoryRelay();
    await relay.push([undo, pay]); // transition first, target second
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.applied, 2);
      const rows = await k.query<{ voided: number }>(`SELECT voided FROM entries WHERE event_id = 'pay-early-undo'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].voided, 1);
      const totals = await k.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
      assert.equal(totals[0].total, null);
    } finally {
      k.close();
    }
  }, 30_000);

  it('resolve before entry still resolves when the target arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const pay = mkEv({
      id: 'pay-late', seq: 2, type: 'entry', actor: 'budi',
      ts: 2, payload: { value: 90000, actor: 'budi' }, prev: 'h1',
    });
    const resolveEv = mkEv({
      id: 'resolve-early', seq: 1, type: 'entry.resolved', actor: 'server',
      ts: 1, payload: { event_id: 'pay-late' }, prev: 'GENESIS',
    });
    const relay = new MemoryRelay();
    await relay.push([resolveEv, pay]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.applied, 2);
      const rows = await k.query<{ state: string }>(`SELECT state FROM entries WHERE event_id = 'pay-late'`);
      assert.equal(rows[0].state, 'RESOLVED_ONLINE');
      const open = await k.query(`SELECT * FROM conflicts WHERE status = 'open' AND kind = 'unknown-entry'`);
      assert.equal(open.length, 0);
    } finally {
      k.close();
    }
  }, 30_000);

  it('in-order arrival still converges (no double-void, no double-resolve)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const pay = mkEv({
      id: 'pay-ordered', seq: 1, type: 'entry', actor: 'budi',
      ts: 1, payload: { value: 60000, actor: 'budi' }, prev: 'GENESIS',
    });
    const undo = mkEv({
      id: 'undo-ordered', seq: 2, type: 'undo.compensate', actor: 'budi',
      ts: 2, payload: { reverses: 'pay-ordered' }, prev: pay.hash,
    });
    const relay = new MemoryRelay();
    await relay.push([pay, undo]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.applied, 2);
      const rows = await k.query<{ voided: number }>(`SELECT voided FROM entries WHERE event_id = 'pay-ordered'`);
      assert.equal(rows[0].voided, 1);
    } finally {
      k.close();
    }
  }, 30_000);

  it('undo before tally.remove restores tally when the remove lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const add = mkEv({
      id: 'add-1', seq: 1, type: 'tally.add', ts: 1,
      payload: { item: 'WIDGET-01', qty: 10 }, prev: 'GENESIS',
    });
    const remove = mkEv({
      id: 'remove-1', seq: 3, type: 'tally.remove', ts: 3,
      payload: { item: 'WIDGET-01', qty: 4 }, prev: 'h2',
    });
    const undo = mkEv({
      id: 'undo-remove-1', seq: 2, type: 'undo.compensate', ts: 2,
      payload: { reverses: 'remove-1' }, prev: 'h1',
    });
    const relay = new MemoryRelay();
    await relay.push([add, undo, remove]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      await k.sync(relay, { chunkSize: 10, ...fast });
      const tally = await k.query<{ qty: number }>(`SELECT qty FROM tally WHERE item = 'WIDGET-01'`);
      assert.equal(tally[0].qty, 10);
      const moves = await k.query<{ voided: number }>(`SELECT voided FROM tally_moves WHERE event_id = 'remove-1'`);
      assert.equal(moves[0].voided, 1);
    } finally {
      k.close();
    }
  }, 30_000);
});
