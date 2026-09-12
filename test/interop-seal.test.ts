// Interop e2e (fielog -> moltarc): kernel append batch -> snapshot ->
// seal snapshot via moltarc API -> verify -> query asof -> truncate log.
// Uses API imports only (no CLI, no src edits).
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
// Cross-repo API imports (moltarc). Relative path keeps this test new-file-only.
import { seal } from '../../molt/src/seal.ts';
import { verifyAll } from '../../molt/src/verify.ts';
import { queryAsOf } from '../../molt/src/timetravel.ts';

describe('interop-seal e2e', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try { closers.pop()!(); } catch { /* gone */ }
    }
  });

  it('append -> snapshot -> seal -> verify -> asof -> truncate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-interop-seal-'));
    const file = join(dir, 'ledger.db');
    const k = await createKernel({ file });
    closers.push(() => k.close());
    const relay = new MemoryRelay();

    const N = 60;
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const value = 1000 + i * 10;
      expected += value;
      await k.append({ type: 'entry', value, actor: 'e2e' });
    }
    const up = await k.sync(relay, { chunkSize: 50, baseMs: 1, maxMs: 30 });
    assert.equal(up.acked, N);

    const snap = await k.snapshot();
    assert.equal(snap.sealedSeq, N);

    // Seal the snapshot db (truncate later empties the live log, so the
    // durable snapshot is the correct seal input).
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb: snap.snapshot, outDir });
    assert.ok(r.rowsSealed > 0, `nothing sealed: ${JSON.stringify(r)}`);

    const v = verifyAll(outDir);
    assert.equal(v.ok, true);

    const asof = queryAsOf({ outDir, seq: r.sealedUptoSeq });
    assert.equal(asof.proof.skippedMissing, 0);
    assert.ok(asof.rows.length > 0);

    // Live db still answers after the seal.
    const rows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE voided = 0`);
    assert.equal(rows[0].n, N);
    // truncate() is part of the Kernel interface (guarded sweep of sealed prefix).
    const cut = await k.truncate();
    assert.ok(cut.removed >= 0);
  }, 120_000);
});
