// Retention: 5000 events -> sync -> snapshot -> truncate. The db keeps
// answering, the log shrinks to a marker, verify passes, sync continues.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

const fast = { baseMs: 1, maxMs: 30 };
const N = 5000;

describe('retention', () => {
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

  it('snapshot, truncate, and keep serving + syncing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-retain-'));
    const file = join(dir, 'kasir.db');
    const k = await createKernel({ file });
    closers.push(() => k.close());
    const relay = new MemoryRelay();

    let expected = 0;
    for (let i = 0; i < N; i++) {
      const nominal = 100 + (i % 997);
      expected += nominal;
      await k.append({ type: 'bayar', nominal, oleh: 'kasir' });
    }
    // Only the acked prefix may be swept: seal it on the relay first.
    const up = await k.sync(relay, { chunkSize: 500, ...fast });
    assert.equal(up.acked, N);

    const snap = await k.snapshot();
    assert.equal(snap.sealedSeq, N);
    assert.equal(snap.dbSeq, N);
    assert.ok(existsSync(snap.snapshot));
    const snapRows = await k.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    assert.equal(snapRows[0].total, expected);

    const before = statSync(k.logPath).size;
    const cut = await k.truncate();
    assert.deepEqual(cut, { removed: N, kept: 0, sealedSeq: N });
    const after = statSync(k.logPath).size;
    assert.ok(after < before / 10, `log did not shrink: ${before} -> ${after}`);
    assert.deepEqual(k.verifyLog(), { ok: true });
    assert.deepEqual(k.health().gaps, []);

    // The db still answers in full after the sweep...
    const rows = await k.query<{ total: number; n: number }>(
      `SELECT SUM(nominal) AS total, COUNT(*) AS n FROM bayar WHERE voided = 0`,
    );
    assert.equal(rows[0].total, expected);
    assert.equal(rows[0].n, N);

    // ...across a reopen (marker re-anchors the chain, seqs never reused)...
    k.close();
    closers.pop();
    const k2 = await createKernel({ file });
    closers.push(() => k2.close());
    assert.deepEqual(k2.verifyLog(), { ok: true });
    const rows2 = await k2.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    assert.equal(rows2[0].total, expected);

    // ...and sync keeps running: ack cursor survived the sweep.
    assert.equal(k2.ackSeq(), N);
    for (let i = 0; i < 100; i++) {
      expected += 7;
      await k2.append({ type: 'bayar', nominal: 7, oleh: 'kasir' });
    }
    const re = await k2.sync(relay, { chunkSize: 50, ...fast });
    assert.equal(re.acked, 100);
    assert.equal(k2.ackSeq(), N + 100);
    assert.equal(relay.size, N + 100);
    const rows3 = await k2.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    assert.equal(rows3[0].total, expected);
  }, 120_000);
});
