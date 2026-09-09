// Relay failover: kernel sync tries relays in order, sticks to the first
// healthy one, parks failures on backoff and re-probes them. Kill the
// primary mid-sync: the run still completes via the secondary, exact-once.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay, type Relay } from '../src/sync.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';

const fast = { baseMs: 1, maxMs: 10 };

describe('relay failover', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()?.();
      } catch {
        /* already dead */
      }
    }
  });

  it('primary dies mid-sync: run completes via secondary, exact-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-failover-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    for (let i = 0; i < 20; i++) {
      await k.append({ type: 'payment', amount: 1000 + i, actor: 'budi' });
    }

    const primary = new MemoryRelay();
    const secondary = new MemoryRelay();
    // Primary serves exactly one chunk, then the link dies mid-sync.
    let calls = 0;
    const dying: Relay = {
      push: (batch) => {
        calls += 1;
        if (calls === 1) return primary.push(batch);
        throw new Error('primary killed mid-sync');
      },
      pull: () => {
        throw new Error('primary killed mid-sync');
      },
    };

    const res = await k.sync([dying, secondary], { chunkSize: 5, ...fast });
    assert.equal(res.acked, 20);
    assert.equal(k.ackSeq(), 20);
    assert.equal(res.pushRelay, 1); // last chunk served by the secondary
    // Relay switch must backfill this run's acked prefix to the new relay:
    // chunk 1 was acked on the primary, so the secondary must end complete.
    assert.equal(primary.pushesReceived, 1);
    assert.ok(secondary.pushesReceived >= 3);
    assert.equal(primary.size, 5);
    assert.equal(secondary.size, 20);
    // Pull rides the secondary too; own echoes apply nothing twice.
    assert.equal(res.applied, 0);
    const rows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment WHERE voided = 0`);
    assert.equal(rows[0].n, 20);
    // A third device reading the newest relay converges on all 20 events.
    const kc = await createKernel({ file: join(dir, 'c.db') });
    closers.push(() => kc.close());
    const rc = await kc.sync(secondary, { ...fast });
    assert.equal(rc.applied, 20);
    const rowsC = await kc.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment WHERE voided = 0`);
    assert.equal(rowsC[0].n, 20);
  });

  it('re-probes the healed primary and fails back to list order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-failback-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    for (let i = 0; i < 5; i++) {
      await k.append({ type: 'payment', amount: 100 + i, actor: 'budi' });
    }

    const primary = new MemoryRelay();
    const secondary = new MemoryRelay();
    primary.failPushes = 1; // primary dark for the first run's push
    const first = await k.sync([primary, secondary], { chunkSize: 5, baseMs: 1, maxMs: 5 });
    assert.equal(first.acked, 5);
    assert.equal(first.pushRelay, 1);
    assert.equal(secondary.size, 5);

    primary.failPushes = 0; // link back up
    for (let i = 0; i < 3; i++) {
      await k.append({ type: 'payment', amount: 200 + i, actor: 'budi' });
    }
    // Backoff carries up to ~100ms jitter: let it expire so the re-probe is due.
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
    const second = await k.sync([primary, secondary], { chunkSize: 5, baseMs: 1, maxMs: 5 });
    assert.equal(second.acked, 3);
    assert.equal(second.pushRelay, 0); // first healthy in list order again
    assert.equal(k.ackSeq(), 8);
  });

  it('all relays down rejects without moving the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-failover-down-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    await k.append({ type: 'payment', amount: 100, actor: 'budi' });

    const dead1 = new MemoryRelay();
    const dead2 = new MemoryRelay();
    dead1.failPushes = 10;
    dead2.failPushes = 10;
    await assert.rejects(k.sync([dead1, dead2], { maxRetries: 0, ...fast }), /unavailable/);
    assert.equal(k.ackSeq(), 0);
  });

  it('real sockets: primary killed mid-sync, secondary finishes the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-failover-ws-'));
    const serverA = new WsRelayServer({ port: 0, file: join(dir, 'a.log') });
    const serverB = new WsRelayServer({ port: 0, file: join(dir, 'b.log') });
    closers.push(() => serverA.kill(), () => serverB.kill());
    const portA = await serverA.start();
    const portB = await serverB.start();

    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    for (let i = 0; i < 20; i++) {
      await k.append({ type: 'payment', amount: 500 + i, actor: 'device' });
    }
    const ca = new WsRelayClient(`ws://127.0.0.1:${portA}`, { ...fast, maxRetries: 2 });
    const cb = new WsRelayClient(`ws://127.0.0.1:${portB}`, { ...fast, maxRetries: 2 });
    closers.push(() => ca.close(), () => cb.close());

    serverA.crashAfter = 1; // primary dies on the first push, before acking
    const res = await k.sync([ca, cb], { chunkSize: 5, ...fast });
    assert.equal(res.acked, 20);
    assert.equal(k.ackSeq(), 20);
    assert.equal(res.applied, 0); // secondary echoes are own UUIDs: nothing double-applied
    // Chunk 1 was write-ahead stored on A before the crash, then re-pushed
    // to B: each relay is exact-once by UUID, union covers all 20 events.
    for (const [s, name] of [[serverA, 'a'], [serverB, 'b']] as const) {
      const ids = s.storedIds();
      assert.equal(new Set(ids).size, ids.length, `relay ${name} holds duplicates`);
    }
    const union = new Set([...serverA.storedIds(), ...serverB.storedIds()]);
    assert.equal(union.size, 20);
    assert.equal(serverB.size, 20);
  }, 30_000);
});
