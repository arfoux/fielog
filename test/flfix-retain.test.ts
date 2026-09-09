// flfix-retain: regression tests for the retain audit fixes.
// (1) Empty logSeqs clamps to 0 — cursors alone never authorize a sweep.
// (2) sweepLogFile fsyncs the containing directory after the rename.
// (3) takeSnapshot checkpoints before stamping, stamps live meta atomically,
//     and refuses concurrent snapshots on the same live db.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { clampSealToStored, sweepLogFile, takeSnapshot } from '../src/retain.ts';
import { openStore } from '../src/store.ts';
import type { EventStore, SqlParams } from '../src/store.ts';

function seedEvents(store: EventStore, seqs: number[]): void {
  for (const s of seqs) {
    store.exec(
      `INSERT INTO _events(seq,id,type,device_id,ts_device,payload,hash,prev_hash) ` +
        `VALUES(${s},'id-${s}','payment','d1',${s},'{}','h${s}','h${s - 1}')`,
    );
  }
}

function freshDb(name: string): { dbPath: string; store: EventStore } {
  const dir = mkdtempSync(join(tmpdir(), `fielog-flfix-retain-${name}-`));
  const dbPath = join(dir, 'ledger.db');
  return { dbPath, store: openStore(dbPath) };
}

describe('flfix-retain', () => {
  it('empty logSeqs clamps to 0 — cursors alone never authorize a sweep', () => {
    const { store } = freshDb('clamp');
    try {
      seedEvents(store, [1, 2, 3, 4, 5]);
      // Nothing proven applied: must be a no-op even with seal == ack.
      assert.equal(clampSealToStored(store, [], 5, 5), 0);
      assert.equal(clampSealToStored(store, [], 100, 50), 0);
      // Control: a proven-applied prefix is still sweepable.
      assert.equal(clampSealToStored(store, [1, 2, 3, 4, 5], 5, 5), 5);
      // Control: a log holding nothing at/below the seal sweeps nothing.
      assert.equal(clampSealToStored(store, [6, 7, 8], 5, 5), 0);
      // Control: a gap in the read-model still clamps below it.
      store.exec(`DELETE FROM _events WHERE seq = 3`);
      assert.equal(clampSealToStored(store, [1, 2, 3, 4, 5], 5, 5), 2);
    } finally {
      store.close();
    }
  });

  it('sweep fsyncs the containing directory after the rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-sweep-'));
    const logPath = join(dir, 'ledger.log');
    const ev = (seq: number): string => JSON.stringify({ seq, id: `id-${seq}`, hash: `h${seq}` });
    writeFileSync(logPath, [ev(1), ev(2), ev(3)].join('\n') + '\n');
    const syncedDirs: string[] = [];
    const res = sweepLogFile(logPath, 2, (d) => {
      syncedDirs.push(d);
    });
    assert.deepEqual(res, { removed: 2, kept: 1, sealedSeq: 2 });
    assert.ok(!existsSync(logPath + '.tmp'), 'sweep tmp must not survive the cutover');
    assert.deepEqual(syncedDirs, [dirname(logPath)], 'rename must be followed by a dir fsync');
    const [markerLine, keptLine] = readFileSync(logPath, 'utf8').split('\n');
    const marker = JSON.parse(markerLine) as { truncated_before: number; next_seq: number };
    assert.equal(marker.truncated_before, 3);
    assert.equal(marker.next_seq, 3);
    assert.equal(keptLine, ev(3));
  });

  it('sweep still dir-fsyncs with the default hook (no injection)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-sweep-default-'));
    const logPath = join(dir, 'ledger.log');
    const ev = (seq: number): string => JSON.stringify({ seq, id: `id-${seq}`, hash: `h${seq}` });
    writeFileSync(logPath, [ev(1), ev(2)].join('\n') + '\n');
    // Must not throw even where directory fsync is unsupported (Windows):
    // the hook swallows platform failure, content durability still holds.
    const res = sweepLogFile(logPath, 1);
    assert.deepEqual(res, { removed: 1, kept: 1, sealedSeq: 1 });
    assert.ok(!existsSync(logPath + '.tmp'));
  });

  it('snapshot checkpoints before stamping and stamps live meta atomically', () => {
    const { dbPath, store: real } = freshDb('snap');
    try {
      seedEvents(real, [1, 2, 3]);
      const order: string[] = [];
      const store: EventStore = {
        ...real,
        exec: (sql: string): void => {
          order.push(`exec:${sql}`);
          real.exec(sql);
        },
        setMeta: (k: string, v: string): void => {
          order.push(`set:${k}=${v}`);
          real.setMeta(k, v);
        },
        query: <T>(sql: string, params?: SqlParams): T[] => {
          order.push(`query:${sql}`);
          return real.query<T>(sql, params);
        },
      };
      const dest = join(dirname(dbPath), 'ledger.snapshot.db');
      const res = takeSnapshot(store, dbPath, 2, dest);
      assert.equal(res.sealedSeq, 2);
      assert.equal(res.dbSeq, 3);
      assert.equal(order[0], `exec:VACUUM INTO '${dest}'`);
      // Checkpoint (MAX read) precedes every stamp.
      const maxIdx = order.findIndex((s) => s.startsWith('query:SELECT MAX(seq)'));
      const firstSet = order.findIndex((s) => s.startsWith('set:'));
      assert.ok(maxIdx >= 0 && firstSet >= 0 && maxIdx < firstSet, `order: ${JSON.stringify(order)}`);
      // Atomic live stamps: BEGIN … set path … set seal … COMMIT, in order.
      const begin = order.findIndex((s) => s === 'exec:BEGIN IMMEDIATE');
      const setPath = order.findIndex((s) => s.startsWith('set:snapshot.path='));
      const setSeal = order.findIndex((s) => s.startsWith('set:snapshot.sealed_seq='));
      const commit = order.findIndex((s) => s === 'exec:COMMIT');
      assert.ok(
        begin >= 0 && setPath > begin && setSeal > setPath && commit > setSeal,
        `atomic stamp order: ${JSON.stringify(order)}`,
      );
      assert.ok(!order.some((s) => s === 'exec:ROLLBACK'), 'happy path never rolls back');
      // Functional: live meta and the snapshot copy agree on the seal.
      assert.equal(real.getMeta('snapshot.sealed_seq'), '2');
      assert.equal(real.getMeta('snapshot.path'), dest);
      const snapDb = new Database(dest);
      try {
        const srows = snapDb.query(`SELECT v FROM _meta WHERE k = 'snapshot.sealed_seq'`).all() as Array<{
          v: string;
        }>;
        assert.equal(srows[0]?.v, '2');
      } finally {
        snapDb.close();
      }
    } finally {
      real.close();
    }
  });

  it('concurrent takeSnapshot fails loud and releases the guard', () => {
    const { dbPath, store: real } = freshDb('guard');
    const dir = dirname(dbPath);
    try {
      seedEvents(real, [1]);
      let reentered = false;
      let innerError: unknown = null;
      const store: EventStore = {
        ...real,
        exec: (sql: string): void => {
          if (!reentered && sql.startsWith('VACUUM INTO')) {
            reentered = true;
            try {
              takeSnapshot(store, dbPath, 1, join(dir, 'inner.snapshot.db'));
            } catch (err) {
              innerError = err;
            }
          }
          real.exec(sql);
        },
      };
      const res = takeSnapshot(store, dbPath, 1, join(dir, 'outer.snapshot.db'));
      assert.ok(reentered, 'reentrancy probe must have fired');
      assert.ok(
        innerError instanceof Error && innerError.message.includes('ERR_SNAPSHOT_IN_FLIGHT'),
        `inner snapshot must fail loud (got ${String(innerError)})`,
      );
      assert.equal(res.sealedSeq, 1);
      // Guard released on success: a later snapshot on the same db works.
      const res2 = takeSnapshot(real, dbPath, 1, join(dir, 'outer2.snapshot.db'));
      assert.equal(res2.sealedSeq, 1);
      // Guard released on failure too: a throwing snapshot must not wedge later ones.
      const bad: EventStore = {
        ...real,
        exec: (): void => {
          throw new Error('boom');
        },
      };
      assert.throws(() => takeSnapshot(bad, dbPath, 1, join(dir, 'bad.snapshot.db')), /boom/);
      const res3 = takeSnapshot(real, dbPath, 1, join(dir, 'outer3.snapshot.db'));
      assert.equal(res3.sealedSeq, 1);
    } finally {
      real.close();
    }
  });
});
