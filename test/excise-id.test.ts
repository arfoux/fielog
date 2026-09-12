// excise-id: swept-UUID reuse must fail loud, never split log vs store silently.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { openStore, type EventStore } from '../src/store.ts';
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

function ev(o: { id: string; seq: number }): LogEvent {
  return {
    id: o.id,
    seq: o.seq,
    type: 'entry',
    device_id: 'excise-dev',
    ts_device: 1700000000000 + o.seq,
    payload: { value: 100, actor: 'k' },
    prev_hash: 'GENESIS',
    hash: `h-${o.id}`,
  };
}

describe('excise-id: swept UUID reuse', () => {
  it('re-appending an excised id throws instead of silently splitting', () => {
    const s: EventStore = openStore(':memory:');
    closers.push(() => s.close());
    s.apply(ev({ id: 'excise-1', seq: 1 }));
    s.apply(ev({ id: 'excise-2', seq: 2 }));
    assert.equal(s.exciseMissing([2], 0), 1);
    assert.equal(s.hasId('excise-1'), false);
    // Same UUID back at a fresh seq: must fail loud.
    assert.throws(() => s.apply(ev({ id: 'excise-1', seq: 3 })), /swept id reused/);
    // And replay surfaces it as skipped, not a silent no-op.
    const r = s.replay([ev({ id: 'excise-1', seq: 3 })]);
    assert.equal(r.applied, 0);
    assert.equal(r.skipped, 1);
  });
});
