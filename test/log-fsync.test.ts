// Torn-tail repair is durable: truncated tail is fsynced (file + dir) and
// the log reopens with prior events intact and no torn bytes left.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog } from '../src/log.ts';

describe('torn-tail fsync repair', () => {
  it('truncates torn tail, keeps prior events, stays stable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-logfsync-'));
    const path = join(dir, 'ledger.log');
    const l1 = openLog(path, 'dev');
    l1.append({ type: 'entry', value: 1 });
    l1.append({ type: 'entry', value: 2 });

    // Simulate a crash mid-write: partial JSON bytes with no trailing newline.
    appendFileSync(path, '{"id":"torn","seq":3,"type":"entry","value":');
    l1.close();

    const before = readFileSync(path, 'utf8');
    assert.ok(before.includes('"value":'));

    const l2 = openLog(path, 'dev');
    try {
      const events = l2.readAll();
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((e) => e.seq), [1, 2]);
      assert.equal(l2.repairedTail, true);
      assert.equal(l2.verify().ok, true);
      const after = readFileSync(path, 'utf8');
      assert.ok(!after.includes('torn'));
      assert.ok(after.endsWith('\n'));
    } finally {
      l2.close();
    }

    const l3 = openLog(path, 'dev');
    try {
      assert.equal(l3.readAll().length, 2);
      assert.equal(l3.verify().ok, true);
    } finally {
      l3.close();
    }
  });
});
