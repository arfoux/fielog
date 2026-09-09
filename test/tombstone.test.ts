// Tombstone engine: soft-delete keeps bytes but hides reads, the gc-guard
// never splits a hide/target pair or sweeps a held event, and legal-hold is
// partial (per id) with an honest held-vs-swept report.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { openStore, type EventStore } from '../src/store.ts';
import { MemoryRelay } from '../src/sync.ts';
import type { LogEvent } from '../src/log.ts';
import {
  TOMBSTONE_HIDE,
  guardSeal,
  hiddenIds,
  hide,
  hold,
  holds,
  isHeld,
  isHidden,
  listTombstones,
  release,
  show,
} from '../src/tombstone.ts';

const fast = { baseMs: 1, maxMs: 30 };

function mkEv(seq: number, id: string, type: string, payload: Record<string, unknown> = {}): LogEvent {
  return {
    id, seq, type, device_id: 'd1', ts_device: 1, payload, prev_hash: 'GENESIS', hash: `h${seq}`,
  };
}

function memStore(): { store: EventStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-tomb-'));
  const store = openStore(join(dir, 't.db'));
  return { store, done: () => store.close() };
}

describe('tombstone', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()!();
      } catch {
        /* gone */
      }
    }
  });

  it('hide folds in seq order and show lifts', () => {
    const { store, done } = memStore();
    closers.push(done);
    store.apply(mkEv(1, 't1', 'note', { isi: 'a' }));
    store.apply(mkEv(2, 't2', 'note', { isi: 'b' }));
    store.apply(mkEv(3, 'h1', TOMBSTONE_HIDE, { hides: 't1' }));
    store.apply(mkEv(4, 'h2', TOMBSTONE_HIDE, { hides: 't2' }));
    assert.deepEqual([...hiddenIds(store)].sort(), ['t1', 't2']);
    assert.equal(isHidden(store, 't1'), true);
    store.apply(mkEv(5, 's1', 'tombstone.show', { shows: 't1' }));
    assert.equal(isHidden(store, 't1'), false);
    assert.equal(isHidden(store, 't2'), true);
    assert.equal(listTombstones(store).length, 3);
    // Bytes are never removed by soft-delete: targets stay in _events.
    assert.equal(store.query(`SELECT COUNT(*) AS n FROM _events`)[0].n, 5);
  });

  it('malformed tombstone bodies never break the fold', () => {
    const { store, done } = memStore();
    closers.push(done);
    store.apply(mkEv(1, 't1', 'note'));
    store.exec(`INSERT INTO records(seq,event_id,type,body) VALUES(2,'bad','${TOMBSTONE_HIDE}','{oops')`);
    store.apply(mkEv(3, 'h1', TOMBSTONE_HIDE, { hides: 't1' }));
    assert.equal(isHidden(store, 't1'), true);
    assert.equal(listTombstones(store).length, 1);
  });

  it('guardSeal never splits a hide/target pair', () => {
    const { store, done } = memStore();
    closers.push(done);
    store.apply(mkEv(1, 't1', 'note'));
    store.apply(mkEv(2, 'other', 'note'));
    store.apply(mkEv(3, 'h1', TOMBSTONE_HIDE, { hides: 't1' }));
    const whole = guardSeal(store, [1, 2, 3], 3, 5);
    assert.equal(whole.effective, 3);
    assert.deepEqual(whole.pairs, []);
    // Seal 2 would sweep the target but leave its hide: clamp below both.
    const split = guardSeal(store, [1, 2, 3], 2, 5);
    assert.equal(split.effective, 0);
    assert.deepEqual(split.pairs, [{ target: 1, hide: 3 }]);
  });

  it('holds block the sweep partially and release unblocks', () => {
    const { store, done } = memStore();
    closers.push(done);
    store.apply(mkEv(1, 'a', 'note'));
    store.apply(mkEv(2, 'b', 'note'));
    store.apply(mkEv(3, 'c', 'note'));
    hold(store, 'b', 'audit dispute device-02');
    assert.equal(isHeld(store, 'b'), true);
    assert.equal(isHeld(store, 'a'), false);
    assert.deepEqual(holds(store), [{ id: 'b', reason: 'audit dispute device-02', seq: 2 }]);
    const guarded = guardSeal(store, [1, 2, 3], 3, 3);
    assert.equal(guarded.effective, 1);
    assert.equal(guarded.held.filter((h) => h.blocks).length, 1);
    // Partial: only the held seq is deferred, the prefix below it still sweeps.
    release(store, 'b');
    assert.equal(isHeld(store, 'b'), false);
    const freed = guardSeal(store, [1, 2, 3], 3, 3);
    assert.equal(freed.effective, 3);
    assert.deepEqual(holds(store), []);
    assert.throws(() => hold(store, 'ghost', 'x'), /ERR_UNKNOWN_TARGET/);
  });

  it('show refuses a non-hidden id before appending', async () => {
    const { store, done } = memStore();
    closers.push(done);
    store.apply(mkEv(1, 't1', 'note'));
    let appended = false;
    const hider = {
      append: async (): Promise<LogEvent> => {
        appended = true;
        throw new Error('must not append');
      },
      query: async <T>(): Promise<T[]> => {
        throw new Error('must not query');
      },
    };
    await assert.rejects(show(hider, store, 't1'), /ERR_NOT_HIDDEN/);
    assert.equal(appended, false);
  });

  it('hide keeps bytes across reopen and fails fast on unknown targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-tomb-k'));
    const file = join(dir, 'ledger.db');
    const k = await createKernel({ file });
    closers.push(() => k.close());
    const a = await k.append({ type: 'note', payload: { isi: 'struk-1' } });
    await k.append({ type: 'note', payload: { isi: 'struk-2' } });
    await hide(k, a.id, { reason: 'wrong value input' });
    assert.equal(k.health().events, 3);
    // Target line stays in the log; the tombstone parks beside it.
    const kept = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE id = ?`, [a.id]);
    assert.equal(kept[0].n, 1);
    const tomb = await k.query<{ body: string }>(`SELECT body FROM records WHERE type = '${TOMBSTONE_HIDE}'`);
    assert.equal(tomb.length, 1);
    const hid: unknown = JSON.parse(tomb[0].body);
    assert.ok(hid && typeof hid === 'object' && 'hides' in hid);
    assert.equal(hid.hides, a.id);
    const before = k.health().events;
    await assert.rejects(hide(k, 'no-such-id'), /ERR_UNKNOWN_TARGET/);
    assert.equal(k.health().events, before);

    k.close();
    closers.pop();
    const k2 = await createKernel({ file });
    closers.push(() => k2.close());
    const kept2 = await k2.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE id = ?`, [a.id]);
    assert.equal(kept2[0].n, 1);
    const tomb2 = await k2.query<{ body: string }>(`SELECT body FROM records WHERE type = '${TOMBSTONE_HIDE}'`);
    assert.equal(tomb2.length, 1);
    const hid2: unknown = JSON.parse(tomb2[0].body);
    assert.ok(hid2 && typeof hid2 === 'object' && 'hides' in hid2);
    assert.equal(hid2.hides, a.id);
  });

  it('hide syncs to a peer like any event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-tomb-s'));
    const ka = await createKernel({ file: join(dir, 'a.db') });
    const kb = await createKernel({ file: join(dir, 'b.db') });
    closers.push(() => ka.close(), () => kb.close());
    const relay = new MemoryRelay();
    const rec = await ka.append({ type: 'note', payload: { isi: 'nota' } });
    await ka.sync(relay, { ...fast });
    await kb.sync(relay, { ...fast });
    const seen = await kb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE id = ?`, [rec.id]);
    assert.equal(seen[0].n, 1);
    await hide(ka, rec.id);
    await ka.sync(relay, { ...fast });
    await kb.sync(relay, { ...fast });
    const tomb = await kb.query<{ body: string }>(`SELECT body FROM records WHERE type = '${TOMBSTONE_HIDE}'`);
    assert.equal(tomb.length, 1);
    const hid3: unknown = JSON.parse(tomb[0].body);
    assert.ok(hid3 && typeof hid3 === 'object' && 'hides' in hid3);
    assert.equal(hid3.hides, rec.id);
  }, 30_000);
});
