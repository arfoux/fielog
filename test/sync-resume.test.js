// Sync resume: relay dies mid-batch, retry resumes from the ack cursor,
// UUID dedupe keeps the relay exact-once.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';

describe('sync resume mid-batch', () => {
  let dir;
  let k;
  let relay;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-sync-'));
    k = await createKernel({ file: join(dir, 'kasir.db') });
    relay = new MemoryRelay();
    for (let i = 0; i < 20; i++) {
      await k.append({ type: 'bayar', nominal: 1000 + i, oleh: 'budi' });
    }
  });
  afterEach(() => k?.close());

  it('resumes after a mid-batch cut with no duplicates', async () => {
    relay.failAfterEvents = 7; // die 7 events into the first chunk
    await assert.rejects(k.sync(relay, { chunkSize: 10, maxRetries: 0, baseMs: 1 }), /mid-batch/);
    assert.equal(k.ackSeq(), 0); // nothing acked: cursor stays put

    relay.failAfterEvents = null; // link back up
    const res = await k.sync(relay, { chunkSize: 10, baseMs: 1 });
    assert.equal(res.acked, 20);
    assert.equal(relay.size, 20); // exact-once by UUID despite the re-push
    assert.equal(k.ackSeq(), 20);
    assert.ok(k.serverTime() !== null); // authoritative time arrived via ack
  });

  it('second sync is a no-op delta', async () => {
    await k.sync(relay, { chunkSize: 10, baseMs: 1 });
    const res = await k.sync(relay, { chunkSize: 10, baseMs: 1 });
    assert.equal(res.pushed, 0);
    assert.equal(res.acked, 0);
  });

  it('rides out transient outages with backoff', async () => {
    relay.failPushes = 2;
    const res = await k.sync(relay, { chunkSize: 25, baseMs: 1 });
    assert.equal(res.acked, 20);
    assert.ok(relay.pushesReceived >= 3);
  });
});
