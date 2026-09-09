// flfix-delta.test.ts — deltasync audit fixes:
// (1) poison dead-letters by UUID (never refetched), (2) fetched counts
// requested ids only, (3) origin-auth stripping contract pin for interop.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog, type AppendLog, type LogEvent } from '../src/log.ts';
import { openStore, type EventStore } from '../src/store.ts';
import { syncDelta, type DeltaPeer } from '../src/deltasync.ts';

let dir: string;
let log: AppendLog;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-delta-'));
  log = openLog(join(dir, 'b.log'), 'b');
  store = openStore(join(dir, 'b.db'));
});

afterEach(() => {
  log?.close();
  store?.close();
});

function mkRemote(id: string, seq: number, over: Partial<LogEvent> = {}): LogEvent {
  return {
    id,
    seq,
    type: 'payment',
    actor: 'budi',
    device_id: 'origin-dev',
    ts_device: 12345,
    payload: { amount: 1000, actor: 'budi' },
    prev_hash: 'origin-prev',
    hash: 'origin-hash',
    ...over,
  };
}

/** Scripted peer over fixed events; records every fetch request. */
function scriptedPeer(events: LogEvent[], seen: string[][]): DeltaPeer {
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    async manifest() {
      return { v: 1, count: events.length, tip: 'tip', ids: events.map((e) => e.id) };
    },
    async fetch(ids: string[]) {
      seen.push([...ids]);
      return ids.map((id) => byId.get(id)).filter((e): e is LogEvent => e !== undefined);
    },
  };
}

describe('deltasync audit fixes', () => {
  it('poison dead-letters by UUID: recorded once, never refetched', async () => {
    const seen: string[][] = [];
    const peer = scriptedPeer(
      [
        mkRemote('good-1', 1),
        // Shape-invalid: checkAppend rejects a non-positive amount.
        mkRemote('poison-1', 2, { payload: { amount: -5, actor: 'budi' } }),
      ],
      seen,
    );

    const first = await syncDelta(log, store, 'b', peer, {
      chunkSize: 10,
      baseMs: 1,
      maxMs: 5,
      cursorKey: 'flfix-dead',
    });
    assert.equal(first.wanted, 2);
    assert.equal(first.applied, 1);
    assert.equal(first.poisoned, 1);
    assert.equal(first.done, true);
    assert.ok(log.hasId('good-1'));
    assert.ok(!log.hasId('poison-1'));
    assert.ok(!store.hasId('poison-1'));

    const dead = store.getMeta('flfix-dead.dead');
    assert.ok(dead);
    assert.deepEqual(JSON.parse(dead).sort(), ['poison-1']);

    // Second run must not refetch the dead UUID at all.
    seen.length = 0;
    const second = await syncDelta(log, store, 'b', peer, {
      chunkSize: 10,
      baseMs: 1,
      maxMs: 5,
      cursorKey: 'flfix-dead',
    });
    assert.equal(second.wanted, 0);
    assert.equal(second.fetched, 0);
    assert.equal(second.applied, 0);
    assert.equal(second.poisoned, 0);
    assert.equal(second.done, true);
    assert.deepEqual(seen, []);
  });

  it('fetched counts requested ids only: extras and duplicates ignored', async () => {
    const good = [mkRemote('g-1', 1), mkRemote('g-2', 2)];
    const junk = mkRemote('unsolicited', 999);
    const seen: string[][] = [];
    const byId = new Map(good.map((e) => [e.id, e]));
    const peer: DeltaPeer = {
      async manifest() {
        return { v: 1, count: 2, tip: 'tip', ids: ['g-1', 'g-2'] };
      },
      async fetch(ids: string[]) {
        seen.push([...ids]);
        // Misbehaving peer: volunteers an unrequested line and a duplicate.
        const out = ids.map((id) => byId.get(id)).filter((e): e is LogEvent => e !== undefined);
        return [...out, junk, byId.get(ids[0])!];
      },
    };

    const res = await syncDelta(log, store, 'b', peer, {
      chunkSize: 10,
      baseMs: 1,
      maxMs: 5,
      cursorKey: 'flfix-fetched',
    });
    assert.equal(res.applied, 2);
    assert.equal(res.fetched, 2);
    assert.equal(res.done, true);
    // The volunteered line is never applied: only want-list ids converge.
    assert.ok(!log.hasId('unsolicited'));
    assert.ok(!store.hasId('unsolicited'));
  });

  it('origin-auth stripping: fresh local chain position, origin kept as metadata', async () => {
    const seen: string[][] = [];
    const peer = scriptedPeer(
      [
        mkRemote('auth-1', 99, {
          signature: 'ORIGIN-SIG',
          countersignatures: [{ deviceId: 'origin-dev', signatureHex: 'abc' }],
        }),
      ],
      seen,
    );

    const res = await syncDelta(log, store, 'b', peer, {
      chunkSize: 10,
      baseMs: 1,
      maxMs: 5,
      cursorKey: 'flfix-auth',
    });
    assert.equal(res.applied, 1);
    assert.equal(res.done, true);

    const ev = log.getById('auth-1');
    assert.ok(ev);
    // Chain position + owner are local: nothing from the origin envelope survives.
    assert.equal(ev.device_id, 'b');
    assert.equal(ev.seq, 1);
    assert.equal(ev.prev_hash, 'GENESIS');
    assert.notEqual(ev.hash, 'origin-hash');
    assert.notEqual(ev.signature, 'ORIGIN-SIG');
    assert.equal(ev.countersignatures, undefined);
    // Origin survives only as audit/display metadata, verbatim otherwise.
    assert.equal(ev.origin_seq, 99);
    assert.equal(ev.origin_device, 'origin-dev');
    assert.equal(ev.ts_device, 12345);
    assert.equal(ev.actor, 'budi');
    assert.equal(ev.type, 'payment');
    assert.deepEqual(ev.payload, { amount: 1000, actor: 'budi' });
  });
});
