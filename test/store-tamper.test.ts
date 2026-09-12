// store-tamper: a well-formed edited line must never merge silently.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type EventStore } from '../src/store.ts';
import { hashFor, type LogEvent } from '../src/log.ts';

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

function mem(): EventStore {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-tamper-'));
  const s = openStore(join(dir, 't.db'));
  closers.push(() => s.close());
  return s;
}

function good(id: string, seq: number, value: number): LogEvent {
  const core = {
    id,
    seq,
    type: 'entry',
    device_id: 'dev',
    ts_device: 1700000000000 + seq,
    payload: { value, state: 'RECORDED' },
    prev_hash: 'GENESIS',
  };
  return { ...core, actor: undefined, hash: hashFor(core) };
}

describe('store tamper gate', () => {
  it('apply rejects a well-formed edited payload instead of merging it', () => {
    const s = mem();
    const tampered = { ...good('a', 1, 10), payload: { value: 9999, state: 'RECORDED' } };
    assert.throws(() => s.apply(tampered), /tamper rejected/);
    assert.equal(s.hasId('a'), false);
    assert.deepEqual(s.query(`SELECT COUNT(*) AS n FROM entries`), [{ n: 0 }]);
  });

  it('replay reports the tampered line as skipped and still applies the healthy tail', () => {
    const s = mem();
    const a = good('a', 1, 10);
    const bad = { ...good('b', 2, 20), payload: { value: 7777, state: 'RECORDED' } };
    const cCore = { id: 'c', seq: 3, type: 'entry', device_id: 'dev', ts_device: 1700000000003, payload: { value: 30, state: 'RECORDED' }, prev_hash: a.hash };
    const c: LogEvent = { ...cCore, actor: undefined, hash: hashFor(cCore) };
    const res = s.replay([a, bad, c]);
    assert.equal(res.skipped, 1);
    assert.equal(res.applied, 2);
    assert.equal(s.hasId('b'), false);
    const rows = s.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(rows[0].total, 40);
  });
});
