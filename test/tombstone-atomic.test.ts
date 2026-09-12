import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { openStore, type EventStore } from '../src/store.ts';
import type { LogEvent } from '../src/log.ts';
import { TOMBSTONE_HIDE, hide, isHidden, listTombstones, show } from '../src/tombstone.ts';
function mkEv(seq: number, id: string, type = 'note', payload: Record<string, unknown> = {}): LogEvent {
  return { id, seq, type, device_id: 'd1', ts_device: 1, payload, prev_hash: 'GENESIS', hash: `h${seq}` };
}

describe('tombstone atomic', () => {
  const closers: Array<() => void> = [];
  afterEach(() => { while (closers.length) closers.pop()!(); });

  it('concurrent double hide appends exactly one hide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-tomb-atomic-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    const target = await k.append({ type: 'note', payload: {} });
    const [a, b] = await Promise.all([hide(k, target.id), hide(k, target.id)]);
    assert.equal(a.payload.hides, target.id);
    assert.equal(b.payload.hides, target.id);
    assert.equal(a.id, b.id);
    const hides = (await k.query<LogEvent>(`SELECT * FROM _events WHERE type = '${TOMBSTONE_HIDE}'`));
    assert.equal(hides.length, 1);
  });

  it('show rejects a mismatched store pair', async () => {
    const s1 = openStore(join(mkdtempSync(join(tmpdir(), 'fielog-tm1-')), 'a.db'));
    const s2 = openStore(join(mkdtempSync(join(tmpdir(), 'fielog-tm2-')), 'b.db'));
    closers.push(() => s1.close(), () => s2.close());
    s1.apply(mkEv(1, 't1'));
    s2.apply(mkEv(1, 't1'));
    s2.apply(mkEv(2, 'h1', TOMBSTONE_HIDE, { hides: 't1' } as unknown as Record<string, unknown>));
    assert.equal(isHidden(s2, 't1'), true);
    const hider = {
      store: s1,
      append: async (): Promise<LogEvent> => { throw new Error('must not append'); },
      query: async <T>(): Promise<T[]> => [{ id: 't1' } as unknown as T],
    };
    await assert.rejects(show(hider, s2, 't1'), /ERR_STORE_MISMATCH/);
  });

  it('show rejects when kernel view and store disagree', async () => {
    const s = openStore(join(mkdtempSync(join(tmpdir(), 'fielog-tm3-')), 'c.db'));
    closers.push(() => s.close());
    s.apply(mkEv(1, 't9'));
    s.apply(mkEv(2, 'h9', TOMBSTONE_HIDE, { hides: 't9' } as unknown as Record<string, unknown>));
    const hider = {
      append: async (): Promise<LogEvent> => { throw new Error('must not append'); },
      query: async <T>(): Promise<T[]> => [] as unknown as T[],
    };
    await assert.rejects(show(hider, s, 't9'), /ERR_STORE_MISMATCH/);
  });

  it('hide then show round-trips on the same replica', async () => {
    const store: EventStore = openStore(join(mkdtempSync(join(tmpdir(), 'fielog-tm-rt-')), 'r.db'));
    closers.push(() => store.close());
    store.apply(mkEv(1, 'r1'));
    let seq = 1;
    const hider = {
      append: async (args: { type: string; payload?: Record<string, unknown> }): Promise<LogEvent> => {
        seq += 1;
        const ev = mkEv(seq, `op${seq}`, args.type);
        ev.payload = args.payload ?? {};
        store.apply(ev);
        return ev;
      },
      query: async <T>(): Promise<T[]> => store.query<T>(`SELECT * FROM _events`),
    };
    await hide(hider, 'r1');
    assert.equal(isHidden(store, 'r1'), true);
    await show(hider, store, 'r1');
    assert.equal(isHidden(store, 'r1'), false);
    assert.equal(listTombstones(store).length, 2);
  });
});
