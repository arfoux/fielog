// flfix-fail.test.ts — fail-closed regression pins for round-7 deep review:
// (1) a throwing isRevoked predicate quarantines the event instead of
// converging it as clean; (2) isDeviceRevoked fails closed when the revoke
// view itself throws; (3) corrupt deltasync resume meta (.want/.dead)
// surfaces instead of silently dropping the queue or resurrecting poison.
import { describe, it, beforeEach, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog, type AppendLog, type LogEvent } from '../src/log.ts';
import { openStore, type EventStore } from '../src/store.ts';
import { isDeviceRevoked, pullRemote, type Relay } from '../src/sync.ts';
import { syncDelta, type DeltaPeer } from '../src/deltasync.ts';

let dir: string;
let log: AppendLog;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-fail-'));
  log = openLog(join(dir, 'ledger.log'), 'devA');
  store = openStore(join(dir, 'ledger.db'));
});

afterEach(() => {
  log?.close();
  store?.close();
});

function entry(id: string, seq: number, device: string, value: number): LogEvent {
  return {
    id, seq, type: 'entry', actor: device, device_id: device, ts_device: seq,
    payload: { value, actor: device }, prev_hash: 'GENESIS', hash: `h-${id}`,
  };
}

describe('fail-closed revoke + resume-meta guards', () => {
  it('a throwing revoke predicate quarantines instead of converging', async () => {
    const tainted = entry('fail-1', 1, 'devB', 5000);
    const stub: Relay = {
      push: async () => ({ acked: [], server_time: 1 }),
      pull: async () => ({ events: [tainted], cursor: 1 }),
    };
    const isRevoked = (_ev: LogEvent): boolean => {
      throw new Error('revoke backend down (injected)');
    };
    const res = await pullRemote(log, store, stub, 'devA', { baseMs: 1, maxMs: 5, isRevoked });
    assert.equal(res.applied, 0, 'an event no predicate could vouch for must not converge');
    assert.equal(res.quarantined, 1, 'unreadable revocation state quarantines with evidence kept');
  });

  it('isDeviceRevoked fails closed when the revoke view throws', () => {
    const broken = {
      revokedTokens(): Array<{ tokenId: string; deviceId: string }> {
        throw new Error('revoke view unreadable (injected)');
      },
    };
    assert.equal(isDeviceRevoked(broken, 'devA'), true, 'unreadable revoke state must read as revoked');
  });

  it('corrupt deltasync resume meta surfaces instead of silently resetting', async () => {
    const peer: DeltaPeer = {
      async manifest() {
        return { v: 1, count: 1, tip: 'tip', ids: ['r-1'] };
      },
      async fetch(ids: string[]) {
        return [entry('r-1', 1, 'origin-dev', 1000)].filter((e) => ids.includes(e.id));
      },
    };
    store.setMeta('failmeta.want', '{torn-json');
    await assert.rejects(
      syncDelta(log, store, 'devA', peer, { chunkSize: 10, baseMs: 1, maxMs: 5, cursorKey: 'failmeta' }),
      /corrupt failmeta\.want/,
      'a corrupt want-list must throw, never silently drop the resume queue',
    );
    store.setMeta('failmeta.want', JSON.stringify(['r-1']));
    store.setMeta('failmeta.dead', '[oops');
    await assert.rejects(
      syncDelta(log, store, 'devA', peer, { chunkSize: 10, baseMs: 1, maxMs: 5, cursorKey: 'failmeta' }),
      /corrupt failmeta\.dead/,
      'a corrupt dead-set must throw, never silently resurrect poison',
    );
  });
});
