// deltasync.test.ts — manifest-first delta sync proofs:
// full sync, mid-cut resume, idempotent replay.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog, type AppendLog, type LogEvent } from '../src/log.ts';
import { openStore, type EventStore } from '../src/store.ts';
import {
  buildManifest,
  computeWant,
  createMemoryPeer,
  syncDelta,
  type DeltaManifest,
  type DeltaPeer,
} from '../src/deltasync.ts';

const N = 20;

function appendPayment(log: AppendLog, store: EventStore, i: number): void {
  const ev = log.append({
    type: 'payment',
    payload: { amount: 1000 + i, actor: 'budi' },
    actor: 'budi',
    device_id: 'a',
  });
  store.apply(ev);
}

/** Peer wrapper that records call order and throws once mid-transfer. */
function flakyPeer(inner: DeltaPeer, calls: string[], failOnFetch: number): DeltaPeer & { fetches: number } {
  const w = { fetches: 0 };
  const peer: DeltaPeer & { fetches: number } = {
    fetches: 0,
    async manifest(): Promise<DeltaManifest> {
      calls.push('manifest');
      return inner.manifest();
    },
    async fetch(ids: string[]): Promise<LogEvent[]> {
      calls.push('fetch');
      peer.fetches += 1;
      w.fetches += 1;
      if (w.fetches === failOnFetch) throw new Error('peer cut mid-transfer (injected failure)');
      return inner.fetch(ids);
    },
  };
  return peer;
}

describe('deltasync manifest-first delta sync', () => {
  let dir: string;
  let la: AppendLog;
  let sa: EventStore;
  let lb: AppendLog;
  let sb: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-delta-'));
    la = openLog(join(dir, 'a.log'), 'a');
    sa = openStore(join(dir, 'a.db'));
    lb = openLog(join(dir, 'b.log'), 'b');
    sb = openStore(join(dir, 'b.db'));
    for (let i = 0; i < N; i++) appendPayment(la, sa, i);
  });

  afterEach(() => {
    la?.close();
    sa?.close();
    lb?.close();
    sb?.close();
  });

  it('full sync: manifest first, want-list only, totals match', async () => {
    const calls: string[] = [];
    const peer = flakyPeer(createMemoryPeer(la), calls, -1);
    const man = buildManifest(la);
    assert.equal(man.count, N);
    assert.equal(computeWant(new Set(), man).length, N);

    const res = await syncDelta(lb, sb, 'b', peer, { chunkSize: 7, baseMs: 1, maxMs: 5 });
    assert.equal(calls[0], 'manifest'); // manifest-first: no fetch before manifest
    assert.equal(res.wanted, N);
    assert.equal(res.applied, N);
    assert.equal(res.done, true);
    assert.equal(res.resumed, false);

    const rows = sb.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
    const want = sa.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
    assert.equal(rows[0].total, want[0].total);
    assert.equal(lb.readAll().length, N);
  });

  it('mid-cut resume: persisted want-list completes with no duplicates', async () => {
    const calls: string[] = [];
    const peer = flakyPeer(createMemoryPeer(la), calls, 2); // die on 2nd fetch chunk
    await assert.rejects(syncDelta(lb, sb, 'b', peer, { chunkSize: 7, baseMs: 1, maxMs: 5, maxRetries: 0 }), /mid-transfer/);
    const partial = sb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment`)[0].n;
    assert.ok(partial > 0 && partial < N); // chunk 1 durable, rest pending
    const persisted = sb.getMeta('deltasync.want');
    assert.ok(persisted && JSON.parse(persisted).length === N - partial); // resume cursor persisted

    const res = await syncDelta(lb, sb, 'b', peer, { chunkSize: 7, baseMs: 1, maxMs: 5 });
    assert.equal(res.resumed, true);
    assert.equal(res.applied, N - partial);
    assert.equal(sb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment`)[0].n, N);
    assert.equal(lb.readAll().length, N);
    // UUID exact-once: one row per id on both sides.
    const dup = sb.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT id FROM _events GROUP BY id HAVING COUNT(*) > 1)`,
    )[0].n;
    assert.equal(dup, 0);
  });

  it('replay idempotent: second run is a no-op, refetch applies nothing twice', async () => {
    const peer = createMemoryPeer(la);
    const first = await syncDelta(lb, sb, 'b', peer, { chunkSize: 7, baseMs: 1 });
    assert.equal(first.applied, N);
    const again = await syncDelta(lb, sb, 'b', peer, { chunkSize: 7, baseMs: 1 });
    assert.equal(again.wanted, 0);
    assert.equal(again.applied, 0);
    assert.equal(again.done, true);
    // Same chunk fetched twice still stores once per UUID.
    const man = await peer.manifest();
    const chunk = await peer.fetch(man.ids.slice(0, 5));
    const third = await syncDelta(lb, sb, 'b', peer, { chunkSize: 7, baseMs: 1 });
    assert.equal(chunk.length, 5);
    assert.equal(third.applied, 0);
    assert.equal(sb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment`)[0].n, N);
  });
});
