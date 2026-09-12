// verifyChain: seq continuity + marker-aware suffix behavior.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GENESIS_HASH, hashFor, openHashChain, verifyChain } from '../src/hashchain.ts';
import { join } from 'node:path';

function twoEvents() {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-hashchain-gap-'));
  const c = openHashChain(join(dir, 'a.log'), 'dev');
  c.append({ type: 'note', payload: { n: 1 } });
  c.append({ type: 'note', payload: { n: 2 } });
  c.append({ type: 'note', payload: { n: 3 } });
  const evs = c.readAll();
  c.close();
  return evs;
}

describe('verifyChain seq/gap awareness', () => {
  it('rejects a silently dropped middle event (re-chained seq gap)', () => {
    const evs = twoEvents();
    // Drop seq 2 and re-chain seq 3 onto seq 1: prev matches but seq jumps.
    const { hash: _h, ...core } = { ...evs[2], prev_hash: evs[0].hash };
    void _h;
    const rechained = { ...core, hash: hashFor(core) };
    const suffix = [evs[0], rechained];
    const v = verifyChain(suffix);
    assert.equal(v.ok, false);
    assert.equal(v.at, evs[2].seq);
  });

  it('rejects duplicate seq', () => {
    const evs = twoEvents();
    const dup = [evs[0], { ...evs[1], seq: evs[0].seq }];
    assert.equal(verifyChain(dup).ok, false);
  });

  it('forgives a quarantined gap jump and echoes it', () => {
    const evs = twoEvents();
    const { hash: _h2, ...core2 } = { ...evs[2], prev_hash: 'forged-tip' };
    void _h2;
    const rechained = { ...core2, hash: hashFor(core2) };
    const v = verifyChain([evs[0], rechained], [evs[2].seq]);
    assert.deepEqual(v, { ok: true, gaps: [evs[2].seq] });
  });

  it('post-sweep suffix verifies with opts.base/startSeq, hints without', () => {
    const evs = twoEvents();
    const suffix = evs.slice(1); // seqs 2..3, prev of seq 2 points at swept seq 1
    const pinned = verifyChain(suffix, [], { base: evs[0].hash, startSeq: suffix[0].seq });
    assert.deepEqual(pinned, { ok: true });
    const bare = verifyChain(suffix);
    assert.equal(bare.ok, false);
    assert.match(bare.reason ?? '', /swept prefix\?/);
    void GENESIS_HASH;
  });

  it('pinned startSeq mismatch fails instead of passing silently', () => {
    const evs = twoEvents();
    const v = verifyChain(evs.slice(1), [], { base: evs[0].hash, startSeq: 999 });
    assert.equal(v.ok, false);
  });
});
