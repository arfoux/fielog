// ack-without-store + truncate-loss chain: ack must imply durable store,
// truncate must never remove unacked/unapplied data.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { openLog } from '../src/log.ts';
import { openStore, type EventStore } from '../src/store.ts';
import { MemoryRelay, getAckSeq, pushPending, listQuarantine } from '../src/sync.ts';
import { takeSnapshot, sweepLogFile } from '../src/retain.ts';

const fast = { baseMs: 1, maxMs: 30 };
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

describe('ack implies durable store; truncate never drops unacked/unapplied', () => {
  it('ack-then-crash chain: logged-but-unapplied event survives sync+truncate+reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-ackstore-'));
    const dbPath = join(dir, 'kasir.db');
    const logPath = join(dir, 'kasir.log');
    const log = openLog(logPath, 'devA');
    const store = openStore(dbPath);
    closers.push(() => log.close(), () => store.close());

    // Healthy prefix.
    const e0 = log.append({ type: 'bayar', payload: { nominal: 100, oleh: 'kasir' } });
    store.apply(e0);
    // Crash window from kernel.append: log.append fsynced, store.apply never ran.
    const lost = log.append({ type: 'bayar', payload: { nominal: 200, oleh: 'kasir' } });
    assert.equal(store.hasId(lost.id), false);

    const relay = new MemoryRelay();
    await pushPending(log, store, relay, fast);
    assert.equal(relay.size, 2);

    const snap = takeSnapshot(store, dbPath, getAckSeq(store));
    log.close(); // release the append fd so the atomic rename can land
    sweepLogFile(logPath, snap.sealedSeq);
    store.close();
    closers.pop();
    closers.pop();

    // Fresh boot replays the swept log into the read model.
    const log2 = openLog(logPath, 'devA');
    const store2 = openStore(dbPath);
    closers.push(() => log2.close(), () => store2.close());
    store2.replay(log2.readAll());

    const rows = store2.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bayar WHERE event_id = ?`,
      [lost.id],
    );
    assert.equal(rows[0].n, 1, 'acked event missing from store after truncate+reopen: permanent loss');
  });

  it('push dead-letters events missing from the store: cursor advances, evidence quarantined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-ackstore-'));
    const dbPath = join(dir, 'kasir.db');
    const logPath = join(dir, 'kasir.log');
    const log = openLog(logPath, 'devA');
    const inner = openStore(dbPath);
    closers.push(() => log.close(), () => inner.close());
    // Store that durably holds nothing new: every apply throws (disk fault).
    const broken: EventStore = new Proxy(inner, {
      get(t, p) {
        if (p === 'apply') return () => {
          throw new Error('injected store fault');
        };
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });

    log.append({ type: 'bayar', payload: { nominal: 50, oleh: 'kasir' } });
    const relay = new MemoryRelay();
    const res = await pushPending(log, broken, relay, fast);
    assert.equal(relay.size, 1, 'relay keeps what it was given; only the ack is at issue');
    assert.equal(res.acked, 0, 'nothing applied, nothing counted as acked');
    // Dead-letter contract: the cursor advances past the deterministically
    // un-storable event so it never pins the batch, but evidence is
    // quarantined and the log bytes stay until reconciled.
    assert.equal(getAckSeq(broken), 1, 'dead-letter advances past the poison event');
    assert.equal(listQuarantine(broken).length, 1, 'poison event evidence quarantined');
  });

  it('truncate-then-sync: unacked suffix survives truncate and still syncs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-ackstore-'));
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    closers.push(() => k.close());
    const relay = new MemoryRelay();

    for (let i = 0; i < 5; i++) await k.append({ type: 'bayar', nominal: 100, oleh: 'kasir' });
    const up = await k.sync(relay, fast);
    assert.equal(up.acked, 5);
    await k.snapshot();

    // Unacked suffix lands after the seal.
    for (let i = 0; i < 3; i++) await k.append({ type: 'bayar', nominal: 7, oleh: 'kasir' });
    const cut = await k.truncate();
    assert.equal(cut.removed, 5);
    assert.equal(cut.kept, 3);

    const re = await k.sync(relay, fast);
    assert.equal(re.acked, 3, 'truncated-away suffix could never sync');
    assert.equal(relay.size, 8);
    const rows = await k.query<{ n: number; total: number }>(
      `SELECT COUNT(*) AS n, SUM(nominal) AS total FROM bayar WHERE voided = 0`,
    );
    assert.deepEqual(rows[0], { n: 8, total: 5 * 100 + 3 * 7 });
  });
});
