// Guard-wire: kernel.truncate must sweep via guardSeal, so a legal hold and a
// hide/target pair survive the sweep and are reported honestly.
//
// Pre-fix failure mode (why these fail without the wire-up): truncate swept
// the raw snapshot seal via clampSealToStored only, so (a) a held event's
// bytes were deleted anyway (removed === sealed instead of stopping below the
// hold), and (b) a target swept while its hide stayed live resurrected/orphaned
// on replay. Both tests assert the guarded outcome.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { hide } from '../src/tombstone.ts';

const fast = { baseMs: 1, maxMs: 30 };

describe('tombstone-guard-wire', () => {
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

  async function mkKernel() {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-guard-wire-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    return k;
  }

  it('truncate stops below a held event and reports the blocker', async () => {
    const k = await mkKernel();
    const relay = new MemoryRelay();
    const e1 = await k.append({ type: 'entry', value: 1, actor: 'device' });
    const e2 = await k.append({ type: 'entry', value: 2, actor: 'device' });
    const e3 = await k.append({ type: 'entry', value: 3, actor: 'device' });
    void e1;
    void e2;
    // Legal hold on the tail event, written through the kernel's query
    // surface (same _meta key hold() uses: `tombstone.hold.<id>`).
    const safeId = e3.id.replace(/'/g, "''");
    await k.query(`INSERT INTO _meta(k,v) VALUES('tombstone.hold.${safeId}','court order')`);
    const up = await k.sync(relay, { chunkSize: 50, ...fast });
    assert.equal(up.acked, 3);
    const snap = await k.snapshot();
    assert.equal(snap.sealedSeq, 3);

    const cut = await k.truncate();
    // Unguarded sweep would claim removed === 3; the guard stops below seq 3.
    assert.equal(cut.removed, 2);
    assert.equal(cut.kept, 1);
    assert.equal(cut.sealedSeq, 2);
    assert.equal(cut.held.length, 1);
    assert.equal(cut.held[0].id, e3.id);
    assert.equal(cut.held[0].blocks, true);
    assert.deepEqual(cut.pairs, []);
    // The held event's bytes are still on disk and still queryable.
    const rows = await k.query<{ id: string }>(`SELECT id FROM _events WHERE id = '${safeId}'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(k.verifyLog(), { ok: true });
  });

  it('truncate never splits a hide/target pair across the sweep', async () => {
    const k = await mkKernel();
    const relay = new MemoryRelay();
    const target = await k.append({ type: 'entry', value: 10, actor: 'device' });
    await k.append({ type: 'entry', value: 20, actor: 'device' });
    const up = await k.sync(relay, { chunkSize: 50, ...fast });
    assert.equal(up.acked, 2);
    const snap = await k.snapshot();
    assert.equal(snap.sealedSeq, 2);
    // Hide lands AFTER the seal: sweeping seq <= 2 would strand the hide
    // (seq 3) without its target (seq 1) — an orphan on replay.
    await hide(k, target.id, { actor: 'device', reason: 'takedown' });

    const cut = await k.truncate();
    // Unguarded sweep would claim removed === 2; the guard refuses the split.
    assert.equal(cut.removed, 0);
    assert.equal(cut.sealedSeq, 0);
    assert.ok(cut.pairs.length > 0, 'expected the split pair to be reported');
    const rows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events`);
    assert.equal(rows[0].n, 3);
    assert.deepEqual(k.verifyLog(), { ok: true });
  });
});
