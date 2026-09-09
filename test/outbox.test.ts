// Bounded outbox: appends past maxPending refuse with ERR_OUTBOX_FULL naming
// the oldest unsynced seq; sync drains in order and re-opens the outbox.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, DEFAULT_OUTBOX_CAP } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

const fast = { baseMs: 1, maxMs: 10 };

describe('bounded outbox', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()?.();
      } catch {
        /* already closed */
      }
    }
  });

  it('refuses past the cap with an actionable ERR_OUTBOX_FULL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-outbox-'));
    const k = await createKernel({ file: join(dir, 'ledger.db'), maxPending: 5 });
    closers.push(() => k.close());
    for (let i = 0; i < 5; i++) {
      await k.append({ type: 'entry', value: 1000 + i, actor: 'budi' });
    }
    await assert.rejects(k.append({ type: 'entry', value: 9999, actor: 'budi' }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /ERR_OUTBOX_FULL/);
      assert.match(msg, /cap 5/);
      assert.match(msg, /oldest unsynced seq is 1/);
      assert.match(msg, /sync/i);
      return true;
    });
    // Refused append leaves no poison behind: still exactly the 5 queued.
    assert.equal(k.health().events, 5);
    assert.equal(k.ackSeq(), 0);
  });

  it('sync drains in order and re-opens the outbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-outbox-drain-'));
    const k = await createKernel({ file: join(dir, 'ledger.db'), maxPending: 5 });
    closers.push(() => k.close());
    const relay = new MemoryRelay();
    for (let i = 0; i < 5; i++) {
      await k.append({ type: 'entry', value: 1000 + i, actor: 'budi' });
    }
    const up = await k.sync(relay, { chunkSize: 2, ...fast });
    assert.equal(up.acked, 5);
    assert.equal(k.ackSeq(), 5);

    // Drained in log order: a second device pulls seqs 1..5 as appended.
    const kb = await createKernel({ file: join(dir, 'ledger2.db') });
    closers.push(() => kb.close());
    const down = await kb.sync(relay, { ...fast });
    assert.equal(down.applied, 5);
    const got = await kb.query<{ value: number }>(`SELECT value FROM entries WHERE voided = 0 ORDER BY seq`);
    assert.deepEqual(
      got.map((r) => r.value),
      [1000, 1001, 1002, 1003, 1004],
    );

    // Outbox open again: appends work, and the next cap names the new oldest seq.
    for (let i = 0; i < 5; i++) {
      await k.append({ type: 'entry', value: 2000 + i, actor: 'budi' });
    }
    await assert.rejects(k.append({ type: 'entry', value: 9999, actor: 'budi' }), /ERR_OUTBOX_FULL.*oldest unsynced seq is 6/);
  });

  it('defaults to a 50k cap when no opt is given', async () => {
    assert.equal(DEFAULT_OUTBOX_CAP, 50_000);
    const dir = mkdtempSync(join(tmpdir(), 'fielog-outbox-default-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    for (let i = 0; i < 10; i++) {
      await k.append({ type: 'entry', value: 10 + i, actor: 'budi' });
    }
    assert.equal(k.health().events, 10);
  });
});
