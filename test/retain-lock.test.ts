import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { snapshotLockPathFor } from '../src/retain.ts';

describe('retain cross-process lock', () => {
  it('fails loud while the lock file is held, succeeds after release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-retain-lock-'));
    const file = join(dir, 'ledger.db');
    const k = await createKernel({ file });
    try {
      await k.append({ type: 'entry', value: 1, actor: 'device' });
      const lockPath = snapshotLockPathFor(file);
      // Simulate a second process holding the lock.
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      await assert.rejects((async () => k.snapshot())(), /ERR_SNAPSHOT_IN_FLIGHT/);
      // Child process must observe the same lock (no silent interleave).
      const proc = Bun.spawnSync({
        cmd: ['bun', '-e', `
          const { createKernel } = await import(${JSON.stringify(join(import.meta.dir, '../src/kernel.ts'))});
          const k = await createKernel({ file: ${JSON.stringify(file)} });
          try { await k.snapshot(); console.log('NO_THROW'); }
          catch (e) { console.log(String(e?.message ?? e).includes('ERR_SNAPSHOT_IN_FLIGHT') ? 'LOCKED' : 'OTHER:' + String(e)); }
          finally { k.close(); }
        `],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = proc.stdout.toString().trim();
      assert.ok(out.includes('LOCKED'), `child should fail loud, got: ${out}`);
      // Release the lock: snapshots work again and clean up the lock file.
      unlinkSync(lockPath);
      const snap = await k.snapshot();
      assert.ok(existsSync(snap.snapshot));
      assert.ok(!existsSync(lockPath));
    } finally {
      k.close();
    }
  });
});
