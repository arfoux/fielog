// Revoke quarantine + retroactive purge: a tainted pull quarantines (evidence
// kept, cursor advances) instead of converging blindly; pre-revoke data purges
// from the read views while the append-only log stays untouched.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { openLog } from '../src/log.ts';
import { openStore } from '../src/store.ts';
import {
  MemoryRelay,
  isDeviceRevoked,
  isQuarantined,
  listQuarantine,
  pullRemote,
  purgeRevoked,
  type Relay,
} from '../src/sync.ts';
import { RevokeLog } from '../src/revokelog.ts';
import { generateDeviceKey } from '../src/auth.ts';
import type { LogEvent } from '../src/log.ts';

const fast = { baseMs: 1, maxMs: 30 };

function bayar(id: string, seq: number, device: string, nominal: number): LogEvent {
  return {
    id, seq, type: 'bayar', actor: device, device_id: device, ts_device: seq,
    payload: { nominal, oleh: device }, prev_hash: 'GENESIS', hash: `h-${id}`,
  };
}

describe('revoke quarantine', () => {
  it('tainted pull quarantines instead of converging blindly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-q-'));
    const relay = new MemoryRelay();
    await relay.push([bayar('good-1', 1, 'devA', 1000), bayar('bad-1', 2, 'devB', 9000)]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const res = await k.sync(relay, { ...fast, revokedDevices: ['devB'] });
      assert.equal(res.pulled, 2);
      assert.equal(res.applied, 1);
      assert.equal(res.quarantined, 1);
      // Read views serve only the clean event.
      const rows = await k.query<{ event_id: string }>(`SELECT event_id FROM bayar ORDER BY event_id`);
      assert.deepEqual(rows.map((r) => r.event_id), ['good-1']);
      // Tainted bytes never touch the local log; evidence lives in _quarantine.
      assert.ok(!readFileSync(k.logPath, 'utf8').includes('bad-1'));
      const q = await k.query<{ event_id: string; reason: string }>(
        `SELECT event_id, reason FROM _quarantine`,
      );
      assert.equal(q.length, 1);
      assert.equal(q[0].event_id, 'bad-1');
      assert.match(q[0].reason, /device revoked: devB/);
      // Cursor advanced past the taint: next sync is a quiet no-op.
      const res2 = await k.sync(relay, { ...fast, revokedDevices: ['devB'] });
      assert.equal(res2.pulled, 0);
      assert.equal(res2.applied, 0);
      assert.equal(res2.quarantined, 0);
      assert.deepEqual(k.verifyLog(), { ok: true });
    } finally {
      k.close();
    }
  }, 30_000);

  it('redelivered revoked events purge from views on the hasId path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-q-'));
    const log = openLog(join(dir, 'kasir.log'), 'devA');
    const store = openStore(join(dir, 'kasir.db'));
    try {
      const tainted = bayar('bad-2', 1, 'devB', 5000);
      const stub: Relay = {
        push: async () => ({ acked: [], server_time: 1 }),
        pull: async () => ({ events: [tainted], cursor: 1 }),
      };
      const clean = await pullRemote(log, store, stub, 'devA', fast);
      assert.equal(clean.applied, 1);
      assert.equal(clean.quarantined, 0);
      // Revoke lands after convergence; the same bytes redelivered purge the views.
      const retro = await pullRemote(log, store, stub, 'devA', { ...fast, revokedDevices: ['devB'] });
      assert.equal(retro.applied, 0);
      assert.equal(retro.quarantined, 1);
      assert.deepEqual(store.query(`SELECT event_id FROM bayar`), []);
      assert.ok(isQuarantined(store, 'bad-2'));
      // The _events row stays so reopen replay cannot resurrect the views.
      assert.notEqual(store.getEventById('bad-2'), null);
    } finally {
      log.close();
      store.close();
    }
  }, 30_000);

  it('revoked-while-parked events quarantine instead of re-driving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-q-'));
    const log = openLog(join(dir, 'kasir.log'), 'devA');
    const store = openStore(join(dir, 'kasir.db'));
    try {
      // Crash window: fsynced in the log, never applied to the read model.
      // device_id devB marks the origin, so the revoke set matches the parked copy.
      log.append({ type: 'bayar', payload: { nominal: 7000, oleh: 'devB' }, device_id: 'devB', id: 'bad-3' });
      const pending = log.getById('bad-3');
      assert.notEqual(pending, null);
      const stub: Relay = {
        push: async () => ({ acked: [], server_time: 1 }),
        pull: async () => ({ events: [{ ...pending! } as LogEvent], cursor: 1 }),
      };
      const res = await pullRemote(log, store, stub, 'devA', { ...fast, revokedDevices: ['devB'] });
      assert.equal(res.applied, 0);
      assert.equal(res.quarantined, 1);
      assert.deepEqual(store.query(`SELECT event_id FROM bayar`), []);
      assert.ok(isQuarantined(store, 'bad-3'));
    } finally {
      log.close();
      store.close();
    }
  }, 30_000);

  it('purgeRevoked sweeps pre-revoke data, keeps the log, idempotent re-sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-q-'));
    const relay = new MemoryRelay();
    await relay.push([bayar('good-4', 1, 'devA', 1000), bayar('bad-4', 2, 'devB', 8000)]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const clean = await k.sync(relay, fast);
      assert.equal(clean.applied, 2);
      k.close();

      // Revoke arrives after convergence: sweep at unit level over the same files.
      const log = openLog(k.logPath, 'devA');
      const store = openStore(join(dir, 'kasir.db'));
      try {
        const out = purgeRevoked(log, store, { revokedDevices: new Set(['devB']) });
        assert.equal(out.scanned, 2);
        assert.equal(out.quarantined, 1);
        assert.deepEqual(
          store.query<{ event_id: string }>(`SELECT event_id FROM bayar ORDER BY event_id`).map((r) => r.event_id),
          ['good-4'],
        );
        // Append-only respected: the log still carries the tainted bytes.
        assert.ok(readFileSync(k.logPath, 'utf8').includes('bad-4'));
        assert.notEqual(store.getEventById('bad-4'), null);
        const rows = listQuarantine(store);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].event_id, 'bad-4');
        const again = purgeRevoked(log, store, { revokedDevices: new Set(['devB']) });
        assert.deepEqual(again, { scanned: 0, quarantined: 0 });
      } finally {
        log.close();
        store.close();
      }
    } catch (e) {
      try { k.close(); } catch { /* already closed */ }
      throw e;
    }
  }, 30_000);

  it('authenticated RevokeLog merge drives predicate quarantine, sibling lives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-q-'));
    const admin = generateDeviceKey('admin-1');
    const admins = { 'admin-1': admin.publicKeyPem };
    const ra = new RevokeLog(admins);
    ra.create(admin.privateKeyPem, 'admin-1', { tokenId: '*', deviceId: 'devB', epoch: 1 });
    const rb = new RevokeLog(admins);
    const m = rb.merge(ra.snapshot());
    assert.equal(m.added, 1);
    assert.ok(isDeviceRevoked(rb, 'devB'));
    assert.ok(!isDeviceRevoked(rb, 'devA'));

    const relay = new MemoryRelay();
    await relay.push([bayar('good-5', 1, 'devA', 1000), bayar('bad-5', 2, 'devB', 6000)]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const isRevoked = (ev: LogEvent): boolean =>
        isDeviceRevoked(rb, typeof ev.origin_device === 'string' && ev.origin_device !== '' ? ev.origin_device : ev.device_id);
      const res = await k.sync(relay, { ...fast, isRevoked });
      assert.equal(res.pulled, 2);
      assert.equal(res.applied, 1);
      assert.equal(res.quarantined, 1);
      const rows = await k.query<{ event_id: string }>(`SELECT event_id FROM bayar ORDER BY event_id`);
      assert.deepEqual(rows.map((r) => r.event_id), ['good-5']);
    } finally {
      k.close();
    }
  }, 30_000);

  it('kernel sync auto-sweeps pre-revoke leftovers without an extra call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-q-'));
    const relay = new MemoryRelay();
    await relay.push([bayar('good-6', 1, 'devA', 1000), bayar('bad-6', 2, 'devB', 4000)]);
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const clean = await k.sync(relay, fast);
      assert.equal(clean.applied, 2);
      assert.equal(clean.quarantined ?? 0, 0);
      // Revoke arrives after convergence: the next sync purges retroactively.
      const retro = await k.sync(relay, { ...fast, revokedDevices: ['devB'] });
      assert.equal(retro.pulled, 0);
      assert.equal(retro.applied, 0);
      assert.equal(retro.quarantined, 1);
      const rows = await k.query<{ event_id: string }>(`SELECT event_id FROM bayar ORDER BY event_id`);
      assert.deepEqual(rows.map((r) => r.event_id), ['good-6']);
      assert.ok(readFileSync(k.logPath, 'utf8').includes('bad-6'));
    } finally {
      k.close();
    }
  }, 30_000);
});
