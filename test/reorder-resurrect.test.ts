// Reorder resurrection: an undo/transition that arrives before its target
// parks (records / unknown-payment conflict) and must re-resolve when the
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
  it('undo before bayar still voids when the target arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const pay = mkEv({
      id: 'pay-early-undo', seq: 2, type: 'bayar', actor: 'budi',
      ts: 2, payload: { nominal: 75000, oleh: 'budi' }, prev: 'h1',
    });
    const undo = mkEv({
      id: 'undo-early', seq: 1, type: 'undo.compensate', actor: 'budi',
      ts: 1, payload: { reverses: 'pay-early-undo' }, prev: 'GENESIS',
    });
    const relay = new MemoryRelay();
    await relay.push([undo, pay]); // transition first, target second
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.applied, 2);
      const rows = await k.query<{ voided: number }>(`SELECT voided FROM bayar WHERE event_id = 'pay-early-undo'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].voided, 1);
      const totals = await k.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
      assert.equal(totals[0].total, null);
    } finally {
      k.close();
    }
  }, 30_000);

  it('settle before bayar still settles when the target arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const pay = mkEv({
      id: 'pay-late', seq: 2, type: 'bayar', actor: 'budi',
      ts: 2, payload: { nominal: 90000, oleh: 'budi' }, prev: 'h1',
    });
    const settle = mkEv({
      id: 'settle-early', seq: 1, type: 'payment.settled', actor: 'server',
      ts: 1, payload: { event_id: 'pay-late' }, prev: 'GENESIS',
    });
    const relay = new MemoryRelay();
    await relay.push([settle, pay]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.applied, 2);
      const rows = await k.query<{ state: string }>(`SELECT state FROM bayar WHERE event_id = 'pay-late'`);
      assert.equal(rows[0].state, 'SETTLED_ONLINE');
      const open = await k.query(`SELECT * FROM conflicts WHERE status = 'open' AND kind = 'unknown-payment'`);
      assert.equal(open.length, 0);
    } finally {
      k.close();
    }
  }, 30_000);

  it('in-order arrival still converges (no double-void, no double-settle)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const pay = mkEv({
      id: 'pay-ordered', seq: 1, type: 'bayar', actor: 'budi',
      ts: 1, payload: { nominal: 60000, oleh: 'budi' }, prev: 'GENESIS',
    });
    const undo = mkEv({
      id: 'undo-ordered', seq: 2, type: 'undo.compensate', actor: 'budi',
      ts: 2, payload: { reverses: 'pay-ordered' }, prev: pay.hash,
    });
    const relay = new MemoryRelay();
    await relay.push([pay, undo]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const res = await k.sync(relay, { chunkSize: 10, ...fast });
      assert.equal(res.applied, 2);
      const rows = await k.query<{ voided: number }>(`SELECT voided FROM bayar WHERE event_id = 'pay-ordered'`);
      assert.equal(rows[0].voided, 1);
    } finally {
      k.close();
    }
  }, 30_000);

  it('undo before stock.sell restores stock when the sell lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-reorder-'));
    const add = mkEv({
      id: 'add-1', seq: 1, type: 'stock.add', ts: 1,
      payload: { item: 'kopi', qty: 10 }, prev: 'GENESIS',
    });
    const sell = mkEv({
      id: 'sell-1', seq: 3, type: 'stock.sell', ts: 3,
      payload: { item: 'kopi', qty: 4 }, prev: 'h2',
    });
    const undo = mkEv({
      id: 'undo-sell-1', seq: 2, type: 'undo.compensate', ts: 2,
      payload: { reverses: 'sell-1' }, prev: 'h1',
    });
    const relay = new MemoryRelay();
    await relay.push([add, undo, sell]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      await k.sync(relay, { chunkSize: 10, ...fast });
      const stock = await k.query<{ qty: number }>(`SELECT qty FROM stock WHERE item = 'kopi'`);
      assert.equal(stock[0].qty, 10);
      const moves = await k.query<{ voided: number }>(`SELECT voided FROM stock_moves WHERE event_id = 'sell-1'`);
      assert.equal(moves[0].voided, 1);
    } finally {
      k.close();
    }
  }, 30_000);
});
