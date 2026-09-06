// cas-store: sha-keyed blobs with explicit refcounts. Same bytes twice cost
// one blob; the blob dies at zero refs; reads re-hash and quarantine.
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  casKeyFor,
  casPathFor,
  casQuarantinePathFor,
  openCas,
} from '../src/cas.ts';

function freshDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `fielog-cas-${tag}-`));
}

describe('cas-store', () => {
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

  it('put returns sha256 key, get round-trips bytes', () => {
    const c = openCas(freshDir('roundtrip'));
    closers.push(() => c.close());
    const key = c.put('struk-001:rp25000');
    assert.equal(key, casKeyFor('struk-001:rp25000'));
    assert.equal(key.length, 64);
    assert.ok(c.has(key));
    assert.equal(c.get(key)?.toString(), 'struk-001:rp25000');
    assert.deepEqual(c.stat(key), { key, size: 17, refcount: 1 });
  });

  it('dedup: same bytes twice share one blob with refcount 2', () => {
    const c = openCas(freshDir('dedup'));
    closers.push(() => c.close());
    const k1 = c.put('foto-struk');
    const k2 = c.put('foto-struk');
    assert.equal(k1, k2);
    assert.equal(c.stat(k1)?.refcount, 2);
    assert.equal(c.unlink(k1), false); // 2 -> 1, blob lives
    assert.ok(c.has(k1));
    assert.equal(c.unlink(k1), true); // 1 -> 0, blob dies
    assert.ok(!c.has(k1));
    assert.equal(c.get(k1), null);
  });

  it('link adds a ref, unlink of unknown key throws', () => {
    const c = openCas(freshDir('link'));
    closers.push(() => c.close());
    const key = c.put('nota');
    c.link(key);
    assert.equal(c.stat(key)?.refcount, 2);
    assert.throws(() => c.link('0'.repeat(64)), /unknown cas key/);
    assert.throws(() => c.unlink('0'.repeat(64)), /unknown cas key/);
    assert.throws(() => c.link('not-a-key'), /bad cas key/);
    assert.equal(c.get('not-a-key'), null);
    assert.equal(c.has('zzz'), false);
  });

  it('refs survive reopen; empty bytes are storable', () => {
    const dir = freshDir('reopen');
    const c = openCas(dir);
    const key = c.put(Buffer.alloc(0));
    c.link(key);
    c.close();
    const c2 = openCas(dir);
    closers.push(() => c2.close());
    assert.equal(c2.stat(key)?.refcount, 2);
    assert.equal(c2.get(key)?.length, 0);
  });

  it('bitrot on read quarantines, never serves, counts once', () => {
    const c = openCas(freshDir('rot'));
    closers.push(() => c.close());
    const key = c.put('asli');
    writeFileSync(casPathFor(c.dir, key), 'palsu!');
    assert.equal(c.get(key), null);
    assert.equal(c.quarantined, 1);
    assert.ok(existsSync(casQuarantinePathFor(c.dir, key)));
    assert.ok(!existsSync(casPathFor(c.dir, key)));
    assert.ok(!c.has(key));
    assert.deepEqual(c.gc(), []); // entry already dropped, nothing left to sweep
  });

  it('gc sweeps manifest entries whose blob went missing', () => {
    const dir = freshDir('gc');
    const c = openCas(dir);
    closers.push(() => c.close());
    const key = c.put('hilang');
    // Simulate a crash window: blob gone, manifest still names it.
    unlinkSync(casPathFor(dir, key));
    assert.deepEqual(c.gc(), [key]);
    assert.equal(c.get(key), null);
  });

  it('corrupt manifest fails closed instead of guessing refs', () => {
    const dir = freshDir('manifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cas.json'), '{not json');
    assert.throws(() => openCas(dir), /corrupt cas manifest/);
    writeFileSync(join(dir, 'cas.json'), JSON.stringify({ refs: { nope: 1 } }));
    assert.throws(() => openCas(dir), /corrupt cas manifest/);
  });
});
