// flfix-log: regression tests for the log.ts audit fixes.
// (1) canonical payload key order, (2) isMarker v===1,
// (3) duplicate explicit id rejection, (4) verify seq skip/dupe.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalOf, hashFor, isMarker, openLog, type LogEvent } from '../src/log.ts';

const freshPath = (tag: string): string => join(mkdtempSync(join(tmpdir(), `flfix-log-${tag}-`)), 'ledger.log');

/** Re-anchor an event onto a new prev hash (what a surgical rewrite would do). */
function rechain(ev: LogEvent, prevHash: string): LogEvent {
  const { hash: _h, signature: _s, countersignatures: _c, ...core } = ev;
  void _h;
  void _s;
  void _c;
  const next = { ...core, prev_hash: prevHash };
  return { ...next, hash: hashFor(next) };
}

describe('flfix-log: canonical payload key order', () => {
  it('same payload in different key order hashes identically (nested too)', () => {
    const base = {
      id: 'x',
      seq: 1,
      type: 't',
      device_id: 'd',
      ts_device: 1,
      prev_hash: 'GENESIS',
    };
    const a = { ...base, actor: undefined, payload: { b: 1, a: { y: 2, x: 1 } } };
    const b = { ...base, actor: undefined, payload: { a: { x: 1, y: 2 }, b: 1 } };
    assert.equal(canonicalOf(a), canonicalOf(b));
    assert.equal(hashFor(a), hashFor(b));
  });

  it('array order still matters (sequences are not sets)', () => {
    const base = {
      id: 'x',
      seq: 1,
      type: 't',
      device_id: 'd',
      ts_device: 1,
      prev_hash: 'GENESIS',
    };
    const c = { ...base, actor: undefined, payload: { l: [1, 2] } };
    const d = { ...base, actor: undefined, payload: { l: [2, 1] } };
    assert.notEqual(canonicalOf(c), canonicalOf(d));
  });
});

describe('flfix-log: isMarker requires v===1', () => {
  it('accepts the swept marker shape', () => {
    assert.equal(
      isMarker({ v: 1, marker: 'fielog-truncate', truncated_before: 2, tip: 'abc', next_seq: 3 }),
      true,
    );
  });

  it('rejects markers without v===1', () => {
    const good = { v: 1, marker: 'fielog-truncate', truncated_before: 2, tip: 'abc', next_seq: 3 };
    const { v: _v, ...noV } = good;
    void _v;
    assert.equal(isMarker(noV), false);
    assert.equal(isMarker({ ...good, v: 2 }), false);
    assert.equal(isMarker({ ...good, v: '1' }), false);
  });

  it('a marker line without v is not honored on open', () => {
    const path = freshPath('marker');
    const log = openLog(path, 'devA');
    log.append({ type: 'note', payload: { isi: 'x' } });
    log.close();
    const bogus = JSON.stringify({
      marker: 'fielog-truncate',
      truncated_before: 1,
      tip: 'GENESIS',
      next_seq: 2,
    });
    writeFileSync(path, bogus + '\n' + readFileSync(path, 'utf8'));
    const r = openLog(path, 'devA');
    try {
      assert.equal(r.sealedBelow, 0);
    } finally {
      r.close();
    }
  });
});

describe('flfix-log: duplicate explicit ids', () => {
  it('append throws on a duplicate explicit id and writes nothing', () => {
    const log = openLog(freshPath('dupe'), 'devA');
    try {
      log.append({ type: 'note', payload: { isi: 'a' }, id: 'dup-id' });
      assert.throws(
        () => log.append({ type: 'note', payload: { isi: 'b' }, id: 'dup-id' }),
        /duplicate id/,
      );
      assert.equal(log.readAll().length, 1);
      assert.equal(log.getById('dup-id')?.payload['isi'], 'a');
    } finally {
      log.close();
    }
  });
});

describe('flfix-log: verify seq continuity', () => {
  it('control: contiguous log still verifies clean', () => {
    const log = openLog(freshPath('control'), 'devA');
    try {
      log.append({ type: 'note', payload: { isi: '1' } });
      log.append({ type: 'note', payload: { isi: '2' } });
      log.append({ type: 'note', payload: { isi: '3' } });
      assert.deepEqual(log.verify(), { ok: true });
    } finally {
      log.close();
    }
  });

  it('flags a seq skip even when the survivor is re-chained (linkage intact)', () => {
    const path = freshPath('skip');
    const log = openLog(path, 'devA');
    const e1 = log.append({ type: 'note', payload: { isi: 'satu' } });
    log.append({ type: 'note', payload: { isi: 'dua' } });
    const e3 = log.append({ type: 'note', payload: { isi: 'tiga' } });
    log.close();
    // Surgical removal: drop seq 2, re-chain seq 3 onto seq 1. prev_hash
    // linkage is perfect, but seqs jump 1 -> 3.
    const e3r = rechain(e3, e1.hash);
    writeFileSync(path, JSON.stringify(e1) + '\n' + JSON.stringify(e3r) + '\n');
    const r = openLog(path, 'devA');
    try {
      const v = r.verify();
      assert.equal(v.ok, false);
      assert.equal(v.at, 3);
      assert.match(v.reason ?? '', /seq gap/);
    } finally {
      r.close();
    }
  });

  it('flags a duplicated seq even when re-chained (linkage intact)', () => {
    const path = freshPath('dupe-seq');
    const log = openLog(path, 'devA');
    const e1 = log.append({ type: 'note', payload: { isi: 'satu' } });
    const e2 = log.append({ type: 'note', payload: { isi: 'dua' } });
    log.close();
    // Forked copy: seq 2 twice, second copy re-chained onto the first.
    const e2b = rechain({ ...e2 }, e2.hash);
    writeFileSync(
      path,
      [e1, e2, e2b].map((e) => JSON.stringify(e) + '\n').join(''),
    );
    const r = openLog(path, 'devA');
    try {
      const v = r.verify();
      assert.equal(v.ok, false);
      assert.equal(v.at, 2);
      assert.match(v.reason ?? '', /duplicate seq/);
    } finally {
      r.close();
    }
  });

  it('quarantined gap still verifies ok with gaps (known gap, not tamper)', () => {
    const path = freshPath('quar');
    const log = openLog(path, 'devA');
    log.append({ type: 'note', payload: { isi: '1' } });
    log.append({ type: 'note', payload: { isi: '2' } });
    log.append({ type: 'note', payload: { isi: '3' } });
    log.close();
    const raw = readFileSync(path, 'utf8').split('\n');
    raw[1] = '{"nope":';
    writeFileSync(path, raw.join('\n'));
    const r = openLog(path, 'devA');
    try {
      assert.equal(r.verify().ok, true);
      assert.deepEqual(r.verify().gaps, [3]);
    } finally {
      r.close();
    }
  });
});
