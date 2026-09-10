// flfix-split: forced store.apply failure → ERR_APPLY_SPLIT + redrive.
// RvTest HIGH-1: kernel.ts ERR_APPLY_SPLIT (durable log line, failed
// read-model apply, re-driven on next append/restart) had zero coverage.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createKernel } from '../src/kernel.ts';

describe('flfix-split', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()?.();
      } catch {
        /* closing */
      }
    }
  });

  it('forced store.apply failure throws ERR_APPLY_SPLIT and redrives on next append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flfix-split-'));
    const file = join(dir, 'ledger.db');
    const k = await createKernel({ file, deviceId: 'split-dev' });
    closers.push(() => k.close());
    await k.append({ type: 'entry', value: 100, actor: 'tester' });

    // Force every read-model apply to fail while the log stays durable: a
    // BEFORE INSERT trigger that aborts, installed over a second handle so
    // the kernel's own connection is untouched.
    const admin = new Database(file);
    try {
      admin.exec(
        `CREATE TRIGGER flfix_fail_apply BEFORE INSERT ON _events BEGIN SELECT RAISE(ABORT, 'flfix injected apply failure'); END;`,
      );
    } finally {
      admin.close();
    }

    const err = await k.append({ type: 'entry', value: 200, actor: 'tester' }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error, 'append must throw when store.apply fails');
    assert.match(err.message, /ERR_APPLY_SPLIT/);
    assert.match(err.message, /re-driven/);

    // Split, not loss: the log line is durable (2 events) but the read-model
    // skipped it (only the baseline row applied).
    assert.equal(k.health().events, 2);
    const have = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events`);
    assert.equal(have[0].n, 1);
    const partial = await k.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(partial[0].total, 100);

    // Heal: drop the trigger; the next append re-drives the durable line first.
    const admin2 = new Database(file);
    try {
      admin2.exec(`DROP TRIGGER flfix_fail_apply`);
    } finally {
      admin2.close();
    }
    await k.append({ type: 'entry', value: 300, actor: 'tester' });

    const back = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events`);
    assert.equal(back[0].n, 3);
    const healed = await k.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(healed[0].total, 600);
    assert.equal(k.health().events, 3);
  });
});
