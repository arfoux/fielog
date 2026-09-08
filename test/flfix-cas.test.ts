// flfix-cas: regression tests for the cas-store audit fixes.
// Each test fails on the pre-fix implementation and passes post-fix:
//   1. gc() sweeps orphan blobs (crash between blob write and manifest persist).
//   2. put() tolerates EEXIST from a concurrent same-key winner.
//   3. stat() uses fstat with no existsSync+read TOCTOU (never throws on race).
//   4. quarantine rename is guarded (occupied sidecar never throws the data path).
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  casKeyFor,
  casPathFor,
  casQuarantinePathFor,
  openCas,
} from '../src/cas.ts';

function freshDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `fielog-flfix-cas-${tag}-`));
}

// Tight create/delete churn over one blob path, run in a child process so the
// main-thread store observes every interleaving of the old existsSync/open
// windows. Same bytes (same key), so adopting the file is always safe.
const CHURN_SRC = `
const { existsSync, writeFileSync, unlinkSync } = await import('node:fs');
const blob = Bun.env.FLFIX_BLOB;
const stop = Bun.env.FLFIX_STOP;
const data = Bun.env.FLFIX_DATA;
let i = 0;
while (!existsSync(stop)) {
  i += 1;
  try { writeFileSync(blob, data); } catch {}
  if (i % 2 === 0) { try { unlinkSync(blob); } catch {} }
}
`;

const churnProcs: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  while (churnProcs.length) {
    const p = churnProcs.pop();
    if (p === undefined) continue;
    try {
      p.kill('SIGKILL');
    } catch {
      // Already exited; exit code observed below.
    }
    try {
      await p.exited;
    } catch {
      // Ignore teardown errors; the assertions already ran.
    }
  }
});

async function withChurn(blob: string, data: string, fn: () => void): Promise<void> {
  const stop = join(dirname(dirname(dirname(blob))), `stop-${process.pid}-${Date.now()}`);
  const proc = Bun.spawn(['bun', '-e', CHURN_SRC], {
    env: { ...process.env, FLFIX_BLOB: blob, FLFIX_STOP: stop, FLFIX_DATA: data },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  churnProcs.push(proc);
  try {
    fn();
  } finally {
    writeFileSync(stop, 'stop');
    await proc.exited;
    churnProcs.splice(churnProcs.indexOf(proc), 1);
  }
}

describe('flfix-cas', () => {
  it('gc sweeps orphan blobs left by a crash between blob write and manifest persist', () => {
    const dir = freshDir('orphan');
    const c = openCas(dir);
    try {
      const data = 'orphan-bytes-never-named-in-manifest';
      const key = casKeyFor(data);
      // Simulate the crash window: blob exclusively created, manifest never
      // persisted, so no ref entry names it.
      const blob = casPathFor(dir, key);
      mkdirSync(dirname(blob), { recursive: true });
      writeFileSync(blob, data);
      assert.ok(existsSync(blob));

      const dead = c.gc();
      assert.ok(dead.includes(key), `gc must report the orphan blob, got ${JSON.stringify(dead)}`);
      assert.ok(!existsSync(blob), 'gc must delete the orphan blob');
      assert.equal(c.get(key), null);
    } finally {
      c.close();
    }
  });

  it('concurrent same-key put tolerates EEXIST instead of throwing', async () => {
    const dir = freshDir('eexist');
    const c = openCas(dir);
    try {
      const data = 'same-key-race-winner-and-loser';
      const key = casKeyFor(data);
      const blob = casPathFor(dir, key);
      // The churn child keeps creating/deleting the same-bytes blob, so some
      // put() call observes existsSync-miss then openSync-EEXIST — the exact
      // concurrent-winner window. Pre-fix that call throws EEXIST.
      await withChurn(blob, data, () => {
        for (let i = 0; i < 500; i++) {
          assert.equal(c.put(data), key);
        }
      });
      c.put(data);
      assert.equal(c.get(key)?.toString(), data);
      const st = c.stat(key);
      assert.ok(st !== null && st.size === data.length);
    } finally {
      c.close();
    }
  });

  it('stat survives the blob vanishing mid-call (fstat, no existsSync/read TOCTOU)', async () => {
    const dir = freshDir('stat');
    const c = openCas(dir);
    try {
      const data = 'stat-race-bytes';
      const key = casKeyFor(data);
      const blob = casPathFor(dir, key);
      c.put(data);
      // Churn deletes the blob underfoot: pre-fix stat() throws ENOENT when
      // the blob vanishes between existsSync and the full readFileSync.
      // Post-fix every call resolves to a stat or null, never throws.
      await withChurn(blob, data, () => {
        for (let i = 0; i < 2000; i++) {
          // The churn child may be mid-write (truncated file): any point-in-
          // time size is honest. The regression property is that stat never
          // throws on the race — pre-fix it throws ENOENT between existsSync
          // and the full readFileSync.
          const s = c.stat(key);
          assert.ok(s === null || (s.key === key && s.size <= data.length && s.refcount === 1));
        }
      });
      c.put(data);
      const s = c.stat(key);
      assert.ok(s !== null && s.key === key && s.size === data.length && s.refcount >= 1);
    } finally {
      c.close();
    }
  });

  it('quarantine rename under a deleting racer never throws the data path', async () => {
    const dir = freshDir('quarrace');
    const c = openCas(dir);
    try {
      const data = 'quarantine-race-good';
      const key = casKeyFor(data);
      const blob = casPathFor(dir, key);
      // The churn child deletes/recreates the blob underfoot: pre-fix get()
      // throws ENOENT/EPERM out of the unguarded quarantine renameSync when
      // the corrupt blob vanishes between the re-hash and the rename.
      // Post-fix every call resolves to bytes or null, never throws.
      await withChurn(blob, data, () => {
        for (let i = 0; i < 300; i++) {
          assert.equal(c.put(data), key);
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              writeFileSync(blob, 'palsu-quar!');
              break;
            } catch {
              // The churn child holds the blob; retry until the corrupt bytes land.
            }
          }
          const v = c.get(key);
          assert.ok(v === null || v.toString() === data);
        }
      });
      // Reset to a known-good blob: the last loop write may have left corrupt
      // bytes that no manifest entry has served yet.
      try {
        unlinkSync(blob);
      } catch {
        // Already gone; put below recreates it.
      }
      assert.equal(c.put(data), key);
      assert.equal(c.get(key)?.toString(), data);
      assert.ok(c.has(key));
    } finally {
      c.close();
    }
  });
});
