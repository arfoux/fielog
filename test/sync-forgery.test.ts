// Forgery laundering: the relay stores verbatim (simple by design), so anyone
// can stash a "entry 1000000 as budi". Pull must verify the ORIGIN signature
// before the local re-hash mints a clean copy; forgeries dead-letter
// (skipped, cursor still advances) instead of landing in the log/read-model.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { generateDeviceKey, signEvent, countersignEvent } from '../src/auth.ts';
import { hashFor, type LogEvent } from '../src/log.ts';

const fast = { baseMs: 1, maxMs: 30 };

function mkEv(o: {
  id: string; seq: number; type: string; actor?: string; deviceId: string;
  ts: number; payload: Record<string, unknown>; prev: string;
}): LogEvent {
  const core = {
    id: o.id, seq: o.seq, type: o.type, actor: o.actor,
    device_id: o.deviceId, ts_device: o.ts, payload: o.payload, prev_hash: o.prev,
  };
  return { ...core, hash: hashFor(core) };
}

const signed = (priv: string, ev: LogEvent): LogEvent => ({ ...ev, signature: signEvent(priv, ev) });

describe('forgery pull gate', () => {
  it('accepts valid signed pulls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-forge-'));
    const budi = generateDeviceKey('budi-dev');
    const e1 = signed(budi.privateKeyPem, mkEv({
      id: 'valid-1', seq: 1, type: 'entry', actor: 'budi', deviceId: budi.deviceId,
      ts: 1, payload: { value: 50000, actor: 'budi' }, prev: 'GENESIS',
    }));
    const relay = new MemoryRelay();
    await relay.push([e1]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const res = await k.sync(relay, { ...fast, trustedDevices: new Map([[budi.deviceId, budi.publicKeyPem]]) });
      assert.equal(res.pulled, 1);
      assert.equal(res.applied, 1);
      const rows = await k.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
      assert.equal(rows[0].total, 50000);
    } finally {
      k.close();
    }
  }, 30_000);

  it('rejects forged 1000000 entry as budi and still advances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-forge-'));
    const budi = generateDeviceKey('budi-dev');
    const mallory = generateDeviceKey('mallory-dev');
    // Forged: claims budi's device id, signed by mallory's key.
    const forged = signed(mallory.privateKeyPem, mkEv({
      id: 'forged-1', seq: 1, type: 'entry', actor: 'budi', deviceId: budi.deviceId,
      ts: 1, payload: { value: 1000000, actor: 'budi' }, prev: 'GENESIS',
    }));
    const relay = new MemoryRelay();
    await relay.push([forged]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const opts = { ...fast, trustedDevices: new Map([[budi.deviceId, budi.publicKeyPem]]) };
      const res = await k.sync(relay, opts);
      assert.equal(res.pulled, 1);
      assert.equal(res.applied, 0);
      const rows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM entries`);
      assert.equal(rows[0].n, 0);
      const evs = await k.query(`SELECT * FROM _events WHERE id = 'forged-1'`);
      assert.equal(evs.length, 0);
      assert.ok(!readFileSync(k.logPath, 'utf8').includes('forged-1'));
      // Cursor advanced past the forgery: no retry storm.
      const res2 = await k.sync(relay, opts);
      assert.equal(res2.pulled, 0);
      assert.equal(res2.applied, 0);
      assert.deepEqual(k.verifyLog(), { ok: true });
    } finally {
      k.close();
    }
  }, 30_000);

  it('mixed pulls keep the valid, drop the forged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-forge-'));
    const budi = generateDeviceKey('budi-dev');
    const mallory = generateDeviceKey('mallory-dev');
    const v1 = signed(budi.privateKeyPem, mkEv({
      id: 'mix-good-1', seq: 1, type: 'entry', actor: 'budi', deviceId: budi.deviceId,
      ts: 1, payload: { value: 10000, actor: 'budi' }, prev: 'GENESIS',
    }));
    // Tampered payload: signed then edited, so the hash no longer matches.
    const t = signed(budi.privateKeyPem, mkEv({
      id: 'mix-forged', seq: 2, type: 'entry', actor: 'budi', deviceId: budi.deviceId,
      ts: 2, payload: { value: 20000, actor: 'budi' }, prev: v1.hash,
    }));
    const tampered: LogEvent = { ...t, payload: { value: 1000000, actor: 'budi' } };
    const wrongKey = signed(mallory.privateKeyPem, mkEv({
      id: 'mix-forged-2', seq: 3, type: 'entry', actor: 'budi', deviceId: budi.deviceId,
      ts: 3, payload: { value: 30000, actor: 'budi' }, prev: 'x',
    }));
    const v2 = signed(budi.privateKeyPem, mkEv({
      id: 'mix-good-2', seq: 4, type: 'entry', actor: 'budi', deviceId: budi.deviceId,
      ts: 4, payload: { value: 40000, actor: 'budi' }, prev: 'y',
    }));
    const relay = new MemoryRelay();
    await relay.push([v1, tampered, wrongKey, v2]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const opts = { ...fast, trustedDevices: new Map([[budi.deviceId, budi.publicKeyPem]]) };
      const res = await k.sync(relay, opts);
      assert.equal(res.pulled, 4);
      assert.equal(res.applied, 2);
      const rows = await k.query<{ event_id: string }>(`SELECT event_id FROM entries ORDER BY value`);
      assert.deepEqual(rows.map((r) => r.event_id), ['mix-good-1', 'mix-good-2']);
      const log = readFileSync(k.logPath, 'utf8');
      assert.ok(!log.includes('mix-forged'));
    } finally {
      k.close();
    }
  }, 30_000);

  it('high-value entry needs the countersign threshold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-forge-'));
    const a = generateDeviceKey('device-a');
    const b = generateDeviceKey('device-b');
    const registry = new Map([[a.deviceId, a.publicKeyPem], [b.deviceId, b.publicKeyPem]]);
    const hv = { limit: 100000, threshold: 2 };
    const big1 = mkEv({
      id: 'big-1', seq: 1, type: 'entry', actor: 'budi', deviceId: a.deviceId,
      ts: 1, payload: { value: 1000000, actor: 'budi' }, prev: 'GENESIS',
    });
    // Single signature only: below threshold, must dead-letter.
    const thin: LogEvent = { ...big1, signature: signEvent(a.privateKeyPem, big1) };
    const relay = new MemoryRelay();
    await relay.push([thin]);
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    try {
      const opts = { ...fast, trustedDevices: registry, highValue: hv };
      const r1 = await k.sync(relay, opts);
      assert.equal(r1.applied, 0);

      // Same event with two distinct countersignatures: accepted.
      const big2 = mkEv({
        id: 'big-2', seq: 2, type: 'entry', actor: 'budi', deviceId: a.deviceId,
        ts: 2, payload: { value: 1000000, actor: 'budi' }, prev: big1.hash,
      });
      const sig = signEvent(a.privateKeyPem, big2);
      const wide: LogEvent = {
        ...big2,
        signature: sig,
        countersignatures: [
          countersignEvent(a.privateKeyPem, a.deviceId, big2),
          countersignEvent(b.privateKeyPem, b.deviceId, big2),
        ],
      };
      await relay.push([wide]);
      const r2 = await k.sync(relay, opts);
      assert.equal(r2.applied, 1);
      const rows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE event_id = 'big-2'`);
      assert.equal(rows[0].n, 1);
    } finally {
      k.close();
    }
  }, 30_000);
});
