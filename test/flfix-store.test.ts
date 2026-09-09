// flfix-store: regression tests for the store.ts audit suspects.
// Each test fails on the pre-fix code and passes after the fix.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { openStore, checkAppend, type EventStore } from '../src/store.ts';
import type { LogEvent } from '../src/log.ts';

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

function track(s: EventStore): EventStore {
  closers.push(() => s.close());
  return s;
}

function ev(o: { id: string; seq: number; type: string; payload?: Record<string, unknown> }): LogEvent {
  return {
    id: o.id,
    seq: o.seq,
    type: o.type,
    device_id: 'flfix-dev',
    ts_device: 1700000000000 + o.seq,
    payload: o.payload ?? {},
    prev_hash: 'GENESIS',
    hash: `h-${o.id}`,
  };
}

describe('flfix store audit', () => {
  it('(1) seq collision under a fresh id fails loud, never swallows as replay', () => {
    const s = track(openStore(':memory:'));
    const a = ev({ id: 'flfix-seq-a', seq: 1, type: 'entry', payload: { value: 100, actor: 'k' } });
    s.apply(a);
    const b = ev({ id: 'flfix-seq-b', seq: 1, type: 'entry', payload: { value: 50, actor: 'k' } });
    assert.throws(() => s.apply(b), /UNIQUE|seq/i);
    assert.equal(s.hasId('flfix-seq-a'), true);
    assert.equal(s.hasId('flfix-seq-b'), false);
    const kept = s.query<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE event_id = ?`, ['flfix-seq-a']);
    assert.equal(kept[0].n, 1);
    // True idempotent replay (same id) stays a silent no-op.
    assert.doesNotThrow(() => s.apply(a));
  });

  it('(2) fractional entry value rejected (integer-value invariant)', () => {
    assert.throws(() => checkAppend('entry', { value: 10.5 }), /integer/);
    assert.throws(() => checkAppend('entry', { value: 0.1 }), /integer/);
    assert.doesNotThrow(() => checkAppend('entry', { value: 100 }));
    const s = track(openStore(':memory:'));
    assert.throws(() =>
      s.apply(ev({ id: 'flfix-frac-1', seq: 1, type: 'entry', payload: { value: 10.5, actor: 'k' } })),
    );
    assert.equal(s.hasId('flfix-frac-1'), false);
  });

  it('(3) duplicate conflict swallowed, disk/locking-class errors rethrown', () => {
    const s = track(openStore(':memory:'));
    const e1 = ev({ id: 'flfix-cf-1', seq: 1, type: 'tally.remove', payload: { item: 'WIDGET-01', qty: 5 } });
    s.apply(e1); // underflow with nothing on hand -> conflict row
    s.exec(`DELETE FROM _events WHERE id = 'flfix-cf-1'`);
    s.exec(`DELETE FROM tally_moves WHERE event_id = 'flfix-cf-1'`);
    const r = s.replay([e1]); // same conflict id re-applied: must not throw
    assert.equal(r.skipped, 0);
    assert.equal(r.applied, 1);

    const s2 = track(openStore(':memory:'));
    s2.exec(`DROP TABLE conflicts`); // every addConflict now hits a real storage error
    const e2 = ev({ id: 'flfix-cf-2', seq: 1, type: 'tally.remove', payload: { item: 'WIDGET-01', qty: 5 } });
    assert.throws(() => s2.apply(e2), /no such table/i);
    assert.equal(s2.hasId('flfix-cf-2'), false);
  });

  it('(4) replay counts skipped poison events and still applies the tail', () => {
    const s = track(openStore(':memory:'));
    const events = [
      ev({ id: 'flfix-rp-g1', seq: 1, type: 'entry', payload: { value: 100, actor: 'k' } }),
      ev({ id: 'flfix-rp-pz', seq: 2, type: 'entry', payload: { value: -5, actor: 'k' } }),
      ev({ id: 'flfix-rp-g2', seq: 3, type: 'entry', payload: { value: 50, actor: 'k' } }),
    ];
    const res = s.replay(events);
    assert.equal(res.applied, 2);
    assert.equal(res.skipped, 1);
    assert.equal(s.hasId('flfix-rp-g1'), true);
    assert.equal(s.hasId('flfix-rp-pz'), false);
    assert.equal(s.hasId('flfix-rp-g2'), true);
  });

  it('(5) exciseMissing is atomic: mid-sweep failure rolls everything back', () => {
    const s = track(openStore(':memory:'));
    const b = ev({ id: 'flfix-ex-b', seq: 1, type: 'entry', payload: { value: 100, actor: 'k' } });
    const a = ev({ id: 'flfix-ex-a', seq: 2, type: 'tally.add', payload: { item: 'WIDGET-01', qty: 10 } });
    s.apply(b);
    s.apply(a);
    // Fail the final tally rebuild: every per-row delete has already run, so
    // without a transaction the sweep is left half-deleted.
    s.exec(`CREATE TRIGGER flfix_boom BEFORE DELETE ON tally BEGIN SELECT RAISE(ABORT, 'flfix-boom'); END;`);
    assert.throws(() => s.exciseMissing([], 0), /flfix-boom/);
    s.exec(`DROP TRIGGER flfix_boom`);
    // All-or-nothing: the rows excised before the failure must have rolled back.
    assert.equal(s.hasId('flfix-ex-b'), true);
    assert.equal(s.hasId('flfix-ex-a'), true);
    assert.equal(s.query<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE event_id = 'flfix-ex-b'`)[0].n, 1);
    assert.equal(
      s.query<{ n: number }>(`SELECT COUNT(*) AS n FROM tally_moves WHERE event_id = 'flfix-ex-a'`)[0].n,
      1,
    );
    assert.equal(s.query<{ q: number }>(`SELECT qty AS q FROM tally WHERE item = 'WIDGET-01'`)[0].q, 10);
    // A clean re-run still converges.
    assert.equal(s.exciseMissing([], 0), 2);
    assert.equal(s.hasId('flfix-ex-b'), false);
  });

  it('(6) getEventById quarantines corrupt rows instead of throwing', () => {
    const s = track(openStore(':memory:'));
    const e = ev({ id: 'flfix-gb-1', seq: 1, type: 'entry', payload: { value: 100, actor: 'k' } });
    s.apply(e);
    s.exec(`UPDATE _events SET payload = '{{{corrupt' WHERE id = 'flfix-gb-1'`);
    assert.equal(s.getEventById('flfix-gb-1'), null);
    assert.equal(s.hasId('flfix-gb-1'), true); // evidence row kept for forensics
    const q = s.query<{ event_id: string; reason: string }>(
      `SELECT event_id, reason FROM _quarantine WHERE event_id = 'flfix-gb-1'`,
    );
    assert.equal(q.length, 1);
    assert.match(q[0].reason, /corrupt-payload/);
    assert.equal(
      s.query<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE event_id = 'flfix-gb-1'`)[0].n,
      0,
    );
    assert.equal(s.getEventById('flfix-gb-1'), null); // stable, still no throw
  });
});
