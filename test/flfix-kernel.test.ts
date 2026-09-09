// flfix-kernel: deviceId split-brain, append/apply split re-drive,
// undo/resolve existence guards, capToken TTL single-source, truncate safety.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { CAP_TOKEN_TTL_MS, generateDeviceKey } from '../src/auth.ts';

describe('flfix-kernel', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()?.();
      } catch {
        /* already closed */
      }
    }
  });

  it('deviceId mismatch stored vs explicit throws instead of split-brain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flfix-kernel-device-'));
    const file = join(dir, 'ledger.db');
    const a = await createKernel({ file, deviceId: 'device-A' });
    closers.push(() => a.close());
    await a.append({ type: 'entry', value: 1000, actor: 'budi' });
    a.close();
    closers.pop();

    await assert.rejects(createKernel({ file, deviceId: 'device-B' }), /ERR_DEVICE_MISMATCH/);

    // Same id and no-explicit reopen keep working.
    const same = await createKernel({ file, deviceId: 'device-A' });
    closers.push(() => same.close());
    assert.equal(same.deviceId, 'device-A');
    assert.equal(same.health().events, 1);
    same.close();
    closers.pop();
    const implicit = await createKernel({ file });
    closers.push(() => implicit.close());
    assert.equal(implicit.deviceId, 'device-A');
  });

  it('restart re-drives a logged-but-unapplied tail split via replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flfix-kernel-split-'));
    const file = join(dir, 'ledger.db');
    const k = await createKernel({ file });
    const parked = await k.append({ type: 'entry', value: 5000, actor: 'budi' });
    // Simulate the kill between log.append and store.apply: the log line is
    // durable (and the tail — a kill cannot leave a hole under later seqs),
    // the read-model rows are gone. A kill implies a restart, which replays.
    await k.query(`DELETE FROM entries WHERE event_id = '${parked.id}'`);
    await k.query(`DELETE FROM _events WHERE id = '${parked.id}'`);
    const gone = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE id = '${parked.id}'`);
    assert.equal(gone[0].n, 0);
    k.close();

    const k2 = await createKernel({ file });
    closers.push(() => k2.close());
    const back = await k2.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE id = '${parked.id}'`);
    assert.equal(back[0].n, 1);
    const rows = await k2.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(rows[0].total, 5000);
  });

  it('undo/resolve on unknown ids append blind compensators (peer target may sync later)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flfix-kernel-guards-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    const ev = await k.append({ type: 'entry', value: 2000, actor: 'budi' });

    // Unknown targets succeed: the target may live on an unsynced peer.
    // Convergence is by fold, not by local existence (model-oracle pins this).
    const blind = await k.undo('no-such-id', 'budi');
    assert.equal(blind.type, 'undo.compensate');
    const blindResolve = await k.resolve('no-such-id', 'failed', 'budi');
    assert.equal(blindResolve.type, 'entry.failed');

    // Known targets still work.
    const undo = await k.undo(ev.id, 'budi');
    assert.equal(undo.type, 'undo.compensate');
    const st = await k.append({ type: 'entry', value: 3000, actor: 'ani' });
    const failed = await k.resolve(st.id, 'failed', 'ani');
    assert.equal(failed.type, 'entry.failed');
  });

  it('capToken default ttl is the auth single source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flfix-kernel-cap-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    assert.equal(CAP_TOKEN_TTL_MS, 15 * 60 * 1000);
    const keys = generateDeviceKey();
    const tok = k.capToken(keys.privateKeyPem);
    assert.equal(tok.deviceId, k.deviceId);
    assert.equal(tok.expiresAt - tok.issuedAt, CAP_TOKEN_TTL_MS);
    // Explicit ttl still honored.
    const long = k.capToken(keys.privateKeyPem, ['relay:push'], 3600 * 1000);
    assert.equal(long.expiresAt - long.issuedAt, 3600 * 1000);
  });

  it('truncate is a safe no-op unsealed and serializes with append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flfix-kernel-trunc-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    for (let i = 0; i < 5; i++) {
      await k.append({ type: 'entry', value: 100 + i, actor: 'budi' });
    }
    const noop = await k.truncate();
    assert.equal(noop.removed, 0);
    assert.equal(noop.kept, 5);

    // Append racing truncate must not corrupt the log or lose events.
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => k.append({ type: 'entry', value: 1000 + i, actor: 'race' })),
      ...Array.from({ length: 5 }, () => k.truncate()),
    ]);
    assert.equal(k.verifyLog().ok, true);
    assert.equal(k.health().events, 25);
    const rows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events`);
    assert.equal(rows[0].n, 25);
    // Kernel still usable after the race.
    const tail = await k.append({ type: 'entry', value: 1, actor: 'budi' });
    assert.ok(tail.seq > 0);
  });
});
