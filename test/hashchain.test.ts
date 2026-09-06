// Append N, verify OK, corrupt 1 -> quarantine, re-anchor, append resumes.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHashChain, quarantinePathFor, verifyChain } from '../src/hashchain.ts';

const N = 12;
const CORRUPT_SEQ = 5; // 1-based line to bitrot

describe('hash-chain-log', () => {
  it('append N, verify OK, corrupt 1 -> quarantine, re-anchor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-hashchain-'));
    const path = join(dir, 'rantang.log');

    // (1) Append N, verify OK.
    const c1 = openHashChain(path, 'hp-uji');
    for (let i = 0; i < N; i++) c1.append({ type: 'catat', payload: { n: i } });
    assert.equal(c1.readAll().length, N);
    assert.deepEqual(c1.verify(), { ok: true });
    assert.deepEqual(verifyChain(c1.readAll()), { ok: true });
    c1.close();

    // (2) Corrupt 1 mid-file line (seq CORRUPT_SEQ).
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[CORRUPT_SEQ - 1] = '{"type":"catat","n":HANCUR';
    writeFileSync(path, lines.join('\n'));

    // (3) Reopen quarantines it; verify re-anchors the survivor.
    const c2 = openHashChain(path, 'hp-uji');
    try {
      assert.equal(c2.quarantined, 1);
      assert.equal(c2.readAll().length, N - 1);
      assert.deepEqual(c2.verify(), { ok: true, gaps: [CORRUPT_SEQ + 1] });
      assert.ok(existsSync(quarantinePathFor(path)));

      // (4) Re-anchor: append resumes from the live tip, chain stays OK.
      const tail = c2.append({ type: 'catat', payload: { n: N } });
      assert.equal(tail.seq, N + 1);
      assert.equal(tail.prev_hash, c2.readAll()[c2.readAll().length - 2].hash);
      const v = c2.verify();
      assert.equal(v.ok, true);
      assert.deepEqual(v.gaps, [CORRUPT_SEQ + 1]);
    } finally {
      c2.close();
    }

    // (5) Stable on reopen: no duplicate forensics.
    const c3 = openHashChain(path, 'hp-uji');
    try {
      assert.equal(c3.quarantined, 1);
      assert.equal(c3.verify().ok, true);
      const q = readFileSync(quarantinePathFor(path), 'utf8').trim().split('\n');
      assert.equal(q.length, 1);
    } finally {
      c3.close();
    }
  });

  it('pure verifyChain rejects tamper without a gap alibi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-hashchain-'));
    const c = openHashChain(join(dir, 'rantang.log'), 'hp-uji');
    try {
      c.append({ type: 'catat', payload: { n: 1 } });
      c.append({ type: 'catat', payload: { n: 2 } });
      const evs = c.readAll();
      const tampered = [{ ...evs[0], payload: { n: 999 } }, evs[1]];
      assert.equal(verifyChain(tampered).ok, false);
      assert.equal(verifyChain(tampered, [evs[1].seq]).ok, false); // hash, not linkage
    } finally {
      c.close();
    }
  });
});
