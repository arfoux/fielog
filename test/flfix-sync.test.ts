// flfix-sync: sync hardening regressions — dead-letter on store.apply failure,
// fail-fast backoff on permanent errors, failover re-push slice math across
// truncate gaps, loud failure on highValue threshold misconfig.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLog, hashFor, type AppendLog, type LogEvent } from '../src/log.ts';
import { openStore, type EventStore } from '../src/store.ts';
import {
  MemoryRelay,
  isPermanentSyncError,
  listQuarantine,
  pullRemote,
  pushPending,
  syncWithFailover,
  withBackoff,
  type Relay,
} from '../src/sync.ts';
import { generateDeviceKey, signEvent, countersignEvent } from '../src/auth.ts';

const fast = { baseMs: 1, maxMs: 5 };

function pair(name: string): { log: AppendLog; store: EventStore; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), name));
  const log = openLog(join(dir, 'a.log'), 'devA');
  const store = openStore(join(dir, 'a.db'));
  return { log, store, close: () => { log.close(); store.close(); } };
}

/** Wrap a real store so apply deterministically fails for one event id. */
function poisonWrap(store: EventStore, poisonId: string): EventStore {
  return {
    ...store,
    apply(ev: LogEvent): void {
      if (ev.id === poisonId) throw new Error('injected apply failure: poison route');
      store.apply(ev);
    },
  };
}

function paymentIds(store: EventStore): string[] {
  return store.query<{ event_id: string }>(`SELECT event_id FROM payment ORDER BY amount`).map((r) => r.event_id);
}

describe('flfix-sync', () => {
  it('push: one un-storable event dead-letters instead of pinning the batch cursor', async () => {
    const { log, store, close } = pair('fielog-flfix-push-');
    try {
      const e1 = log.append({ type: 'payment', payload: { amount: 1000, actor: 'budi' } });
      const e2 = log.append({ type: 'payment', payload: { amount: 2000, actor: 'budi' } });
      const e3 = log.append({ type: 'payment', payload: { amount: 3000, actor: 'budi' } });
      const wrapped = poisonWrap(store, e2.id);
      const relay = new MemoryRelay();

      const res = await pushPending(log, wrapped, relay, { chunkSize: 10, ...fast });
      assert.equal(res.pushed, 3);
      assert.equal(res.acked, 2);
      // Cursor advanced PAST the poison: the batch is not pinned.
      assert.equal(store.getMeta('sync.ack_seq'), String(e3.seq));
      const q = listQuarantine(store);
      assert.equal(q.length, 1);
      assert.equal(q[0].event_id, e2.id);
      assert.match(q[0].reason, /apply failed/);
      // Read-model converged on everything except the quarantined poison.
      assert.deepEqual(paymentIds(store), [e1.id, e3.id]);

      // Next run is a no-op delta, not a retry storm.
      const res2 = await pushPending(log, wrapped, relay, { chunkSize: 10, ...fast });
      assert.equal(res2.pushed, 0);
      assert.equal(res2.acked, 0);
    } finally {
      close();
    }
  });

  it('pull: one un-storable event dead-letters and the cursor still advances', async () => {
    const { log, store, close } = pair('fielog-flfix-pull-');
    try {
      const mk = (id: string, seq: number, amount: number): LogEvent => ({
        id, seq, type: 'payment', actor: 'budi', device_id: 'devA', ts_device: seq,
        payload: { amount, actor: 'budi' }, prev_hash: 'GENESIS', hash: `h-${id}`,
      });
      const relay = new MemoryRelay();
      await relay.push([mk('g-1', 1, 1000), mk('p-1', 2, 2000), mk('g-2', 3, 3000)]);
      const wrapped = poisonWrap(store, 'p-1');

      const res = await pullRemote(log, wrapped, relay, 'devB', { chunkSize: 10, ...fast });
      assert.equal(res.pulled, 3);
      assert.equal(res.applied, 2);
      assert.equal(listQuarantine(store).length, 1);
      assert.deepEqual(paymentIds(store), ['g-1', 'g-2']);

      // Cursor advanced past the poison: no retry storm, no duplicate lines.
      const res2 = await pullRemote(log, wrapped, relay, 'devB', { chunkSize: 10, ...fast });
      assert.equal(res2.pulled, 0);
      assert.equal(res2.applied, 0);
      assert.equal(log.readAll().length, 3);
    } finally {
      close();
    }
  });

  it('withBackoff fails fast on permanent errors, retries transient ones', async () => {
    let permCalls = 0;
    await assert.rejects(
      withBackoff(
        async () => {
          permCalls += 1;
          throw new Error('relay rejected push: forbidden (capability rejected for relay:push)');
        },
        { maxRetries: 5, ...fast },
      ),
      /forbidden/,
    );
    assert.equal(permCalls, 1);

    let cursorCalls = 0;
    await assert.rejects(
      withBackoff(
        async () => {
          cursorCalls += 1;
          throw new Error('relay rejected revoke_pull: bad cursor 99');
        },
        { maxRetries: 5, ...fast },
      ),
      /bad cursor/,
    );
    assert.equal(cursorCalls, 1);

    // Transient outages still retry to the limit.
    let transientCalls = 0;
    await assert.rejects(
      withBackoff(
        async () => {
          transientCalls += 1;
          throw new Error('relay unavailable (injected failure)');
        },
        { maxRetries: 2, ...fast },
      ),
      /unavailable/,
    );
    assert.equal(transientCalls, 3);

    assert.ok(isPermanentSyncError(Object.assign(new Error('wrapped'), { code: 'forbidden' })));
    assert.ok(!isPermanentSyncError(new Error('ws dropped')));
    assert.ok(!isPermanentSyncError(new Error('relay cut mid-batch after 1/5')));
  });

  it('failover re-push selects the acked prefix by seq bound, not seq arithmetic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-gap-'));
    const store = openStore(join(dir, 's.db'));
    try {
      store.setMeta('sync.ack_seq', '5');
      const mk = (seq: number): LogEvent => ({
        id: `e${seq}`, seq, type: 'payment', actor: 'budi', device_id: 'devA', ts_device: seq,
        payload: { amount: 1000 + seq, actor: 'budi' }, prev_hash: 'x', hash: `h${seq}`,
      });
      // Post-truncate log: seqs 1..7 swept, the live suffix restarts at 8.
      const events = [mk(8), mk(9), mk(10), mk(11)];
      const log = {
        readAfter: (seq: number) => events.filter((e) => e.seq > seq),
      } as unknown as AppendLog;

      const seen: string[][] = [];
      let primaryCalls = 0;
      const primary: Relay = {
        push: async (batch) => {
          primaryCalls += 1;
          if (primaryCalls > 1) throw new Error('relay unavailable (injected failure)');
          return { acked: batch.map((e) => e.id), server_time: 999 };
        },
        pull: async () => ({ events: [], cursor: 0 }),
      };
      const secondary: Relay = {
        push: async (batch) => {
          seen.push(batch.map((e) => e.id));
          return { acked: batch.map((e) => e.id), server_time: 1000 };
        },
        pull: async () => ({ events: [], cursor: 0 }),
      };

      const res = await syncWithFailover(log, store, [primary, secondary], 'devA', { chunkSize: 2, ...fast });
      assert.equal(res.acked, 4);
      assert.equal(store.getMeta('sync.ack_seq'), '11');
      // Chunk 2 failed over to the secondary: it must receive the current
      // chunk once plus the acked prefix [e8,e9] once — never the current
      // chunk twice via an overshooting prefix slice.
      assert.deepEqual(seen, [['e10', 'e11'], ['e8', 'e9']]);
      assert.equal(primaryCalls, 2);
    } finally {
      store.close();
    }
  });

  it('highValue threshold misconfig fails loud instead of dead-lettering payments', async () => {
    const { log, store, close } = pair('fielog-flfix-hv-');
    try {
      const budi = generateDeviceKey('budi-dev');
      const mkRelayEv = (id: string, seq: number, extra?: Partial<LogEvent>): LogEvent => {
        const core = {
          id, seq, type: 'payment', actor: 'budi', device_id: 'budi-dev', ts_device: seq,
          payload: { amount: 1_000_000, actor: 'budi' }, prev_hash: 'GENESIS',
        };
        const unsigned: LogEvent = { ...core, hash: hashFor(core) };
        return { ...unsigned, signature: signEvent(budi.privateKeyPem, unsigned), ...extra };
      };
      const registry = new Map([[budi.deviceId, budi.publicKeyPem]]);
      const relay = new MemoryRelay();
      await relay.push([mkRelayEv('hv-1', 1)]);

      // Threshold 2 with a single trusted device can never verify: operator
      // misconfig. Sync must reject loudly, not swallow the payment.
      await assert.rejects(
        pullRemote(log, store, relay, 'devB', {
          ...fast,
          trustedDevices: registry,
          highValue: { limit: 100_000, threshold: 2 },
        }),
        /highValue misconfigured/,
      );
      // Nothing converged and nothing was silently skipped: the payment waits.
      assert.equal(log.readAll().length, 0);
      assert.equal(store.getMeta('sync.pull_cursor'), null);

      // A satisfiable threshold still converges a properly countersigned event,
      // while malformed countersignature data dead-letters without throwing.
      const hv2 = mkRelayEv('hv-2', 2, {
        countersignatures: [countersignEvent(budi.privateKeyPem, budi.deviceId, mkRelayEv('hv-2', 2))],
      });
      const hv3 = mkRelayEv('hv-3', 3, { countersignatures: [null] as unknown as LogEvent['countersignatures'] });
      await relay.push([hv2, hv3]);
      const res = await pullRemote(log, store, relay, 'devB', {
        ...fast,
        trustedDevices: registry,
        highValue: { limit: 100_000, threshold: 1 },
      });
      assert.equal(res.applied, 1);
      assert.deepEqual(paymentIds(store), ['hv-2']);
      assert.equal(store.getMeta('sync.pull_cursor'), '3');
    } finally {
      close();
    }
  });
});
