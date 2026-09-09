// flfix-perf-sync: sync perf regressions — purgeRevoked scans only the new log
// suffix under stable revoke state (cursor + fingerprint persisted in store
// meta), and backoff jitter is deterministic by default (random on opt-in).
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog, type AppendLog, type LogEvent } from '../src/log.ts';
import { openStore, type EventStore } from '../src/store.ts';
import {
  MemoryRelay,
  backoffMs,
  getPurgeSeq,
  pullRemote,
  purgeRevoked,
  withBackoff,
} from '../src/sync.ts';

function pair(name: string, device = 'evil'): { dir: string; log: AppendLog; store: EventStore; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), name));
  const log = openLog(join(dir, 'a.log'), device);
  const store = openStore(join(dir, 'a.db'));
  return { dir, log, store, close: () => { log.close(); store.close(); } };
}

function appendEntry(log: AppendLog, store: EventStore, value: number, deviceId?: string): LogEvent {
  const ev = log.append({ type: 'entry', payload: { value, actor: 'device' }, device_id: deviceId });
  store.apply(ev);
  return ev;
}

function relayEntry(id: string, seq: number, device: string, value: number): LogEvent {
  return {
    id, seq, type: 'entry', actor: device, device_id: device, ts_device: seq,
    payload: { value, actor: device }, prev_hash: 'GENESIS', hash: `h-${id}`,
  };
}

describe('flfix-perf-sync', () => {
  it('purgeRevoked scans only the new suffix under stable revoke state', () => {
    const { log, store, close } = pair('fielog-perf-sync-');
    try {
      for (let i = 0; i < 3; i++) appendEntry(log, store, 100 + i);
      const first = purgeRevoked(log, store, { revokedDevices: new Set(['evil']) });
      assert.deepEqual(first, { scanned: 3, quarantined: 3 });
      assert.equal(getPurgeSeq(store), log.maxSeq());
      assert.deepEqual(store.query(`SELECT event_id FROM entries`), []);
      // Steady state: same revoke set, nothing new — no rescan.
      const second = purgeRevoked(log, store, { revokedDevices: new Set(['evil']) });
      assert.deepEqual(second, { scanned: 0, quarantined: 0 });
      // New suffix only, across Set/array shapes of the same set.
      for (let i = 0; i < 2; i++) appendEntry(log, store, 200 + i);
      const third = purgeRevoked(log, store, { revokedDevices: ['evil'] });
      assert.deepEqual(third, { scanned: 2, quarantined: 2 });
      assert.equal(getPurgeSeq(store), log.maxSeq());
    } finally {
      close();
    }
  });

  it('purge cursor survives reopen via store meta', () => {
    const { dir, log, store, close } = pair('fielog-perf-sync-');
    for (let i = 0; i < 2; i++) appendEntry(log, store, 100 + i);
    assert.deepEqual(purgeRevoked(log, store, { revokedDevices: ['evil'] }), { scanned: 2, quarantined: 2 });
    close();
    const log2 = openLog(join(dir, 'a.log'), 'evil');
    const store2 = openStore(join(dir, 'a.db'));
    try {
      assert.equal(getPurgeSeq(store2), 2);
      assert.deepEqual(purgeRevoked(log2, store2, { revokedDevices: ['evil'] }), { scanned: 0, quarantined: 0 });
    } finally {
      log2.close();
      store2.close();
    }
  });

  it('grown revoke set falls back to a full rescan', () => {
    const { log, store, close } = pair('fielog-perf-sync-', 'devA');
    try {
      appendEntry(log, store, 100, 'devA');
      appendEntry(log, store, 200, 'devB');
      assert.deepEqual(purgeRevoked(log, store, { revokedDevices: ['devA'] }), { scanned: 2, quarantined: 1 });
      assert.deepEqual(
        store.query<{ event_id: string }>(`SELECT event_id FROM entries`).map((r) => r.event_id).length,
        1,
      );
      // devB revoked later: the prefix must rescan, or its pre-revoke row survives.
      assert.deepEqual(
        purgeRevoked(log, store, { revokedDevices: ['devA', 'devB'] }),
        { scanned: 2, quarantined: 1 },
      );
      assert.deepEqual(store.query(`SELECT event_id FROM entries`), []);
    } finally {
      close();
    }
  });

  it('unversioned predicate always rescans so late revokes still purge', () => {
    const { log, store, close } = pair('fielog-perf-sync-', 'devA');
    try {
      appendEntry(log, store, 100, 'devA');
      appendEntry(log, store, 200, 'devB');
      const revoked = new Set(['devA']);
      const isRevoked = (ev: LogEvent): boolean => revoked.has(ev.device_id);
      assert.deepEqual(purgeRevoked(log, store, { isRevoked }), { scanned: 2, quarantined: 1 });
      // Revoke state mutated behind the same closure: a suffix-only scan would miss devB.
      revoked.add('devB');
      assert.deepEqual(purgeRevoked(log, store, { isRevoked }), { scanned: 2, quarantined: 1 });
      assert.deepEqual(store.query(`SELECT event_id FROM entries`), []);
    } finally {
      close();
    }
  });

  it('versioned predicate goes incremental; a version bump rescans', () => {
    const { log, store, close } = pair('fielog-perf-sync-', 'devA');
    try {
      appendEntry(log, store, 100, 'devA');
      appendEntry(log, store, 200, 'devB');
      const isRevoked = (ev: LogEvent): boolean => ev.device_id === 'devA';
      assert.deepEqual(
        purgeRevoked(log, store, { isRevoked, revokeVersion: 3 }),
        { scanned: 2, quarantined: 1 },
      );
      assert.deepEqual(
        purgeRevoked(log, store, { isRevoked, revokeVersion: 3 }),
        { scanned: 0, quarantined: 0 },
      );
      assert.deepEqual(
        purgeRevoked(log, store, { isRevoked, revokeVersion: 4 }),
        { scanned: 2, quarantined: 0 },
      );
    } finally {
      close();
    }
  });

  it('pullRemote with revoke signal advances the persisted purge cursor', async () => {
    const { log, store, close } = pair('fielog-perf-sync-', 'devA');
    try {
      const relay = new MemoryRelay();
      await relay.push([relayEntry('good-p', 1, 'devA', 1000), relayEntry('bad-p', 2, 'devB', 9000)]);
      const res = await pullRemote(log, store, relay, 'devA', { baseMs: 1, maxMs: 5, revokedDevices: ['devB'] });
      assert.equal(res.pulled, 2);
      assert.equal(res.applied, 1);
      assert.equal(res.quarantined, 1);
      assert.equal(getPurgeSeq(store), log.maxSeq());
      const again = await pullRemote(log, store, relay, 'devA', { baseMs: 1, maxMs: 5, revokedDevices: ['devB'] });
      assert.deepEqual([again.pulled, again.applied, again.quarantined], [0, 0, 0]);
    } finally {
      close();
    }
  });

  it('backoffMs is deterministic by default and pinnable', () => {
    // baseMs=1, maxMs=5: 1+37, 2+74, 4+11, 5+48 — jitter seeded by attempt.
    assert.equal(backoffMs(0, 1, 5), 38);
    assert.equal(backoffMs(1, 1, 5), 76);
    assert.equal(backoffMs(2, 1, 5), 15);
    assert.equal(backoffMs(3, 1, 5), 53);
    for (let a = 0; a < 6; a++) assert.equal(backoffMs(a), backoffMs(a));
  });

  it('backoffMs jitter opt-in: fixed number or custom source', () => {
    assert.equal(backoffMs(0, 1, 5, 7), 8);
    assert.equal(backoffMs(0, 1, 5, () => 0.5), 51);
    assert.equal(backoffMs(2, 100, 1000, () => 0.99), 499);
  });

  it('withBackoff retries transient failures on deterministic sleeps', async () => {
    let calls = 0;
    const t0 = Date.now();
    const out = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('relay unavailable (injected failure)');
        return 'ok';
      },
      { baseMs: 1, maxMs: 5, maxRetries: 3 },
    );
    assert.equal(out, 'ok');
    assert.equal(calls, 3);
    // Deterministic sleeps: (1+37) + (2+74) = 114ms floor.
    assert.ok(Date.now() - t0 >= 100, 'sleeps should cover the deterministic backoff floor');
    let randomCalls = 0;
    const routed = await withBackoff(
      async () => {
        randomCalls += 1;
        if (randomCalls < 2) throw new Error('relay unavailable (injected failure)');
        return 'ok';
      },
      { baseMs: 1, maxMs: 5, maxRetries: 2, jitter: true },
    );
    assert.equal(routed, 'ok');
  });
});
