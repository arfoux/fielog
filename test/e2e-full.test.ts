// e2e-full.test.ts — the entire fielog user journey in one tmp dir:
// init kernel, 1000 mixed multi-actor events, sync across 2 file-backed
// relays, SIGKILL mid-append, reopen + recover, undo flows, kill-primary
// failover to secondary, capability revoke mid-stream, cli demo totals.
// End-state: totals match the intent mirror, no acked event lost, verify ok.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';
import { generateDeviceKey } from '../src/auth.ts';
import { intentFor, mirrorFor } from './e2e-intents.ts';

const fast = { baseMs: 1, maxMs: 30 };
const TOTAL = 1000;

async function waitFor(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function logLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

describe('fielog full journey', () => {
  it('init, 1000 events, crash, undo, failover, revoke, cli demo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-e2e-'));
    const dbFile = join(dir, 'ledger.db');
    const logFile = join(dir, 'ledger.log');
    const keyA = generateDeviceKey('device-a');
    const keyB = generateDeviceKey('device-b');
    const registry = { 'device-a': keyA.publicKeyPem, 'device-b': keyB.publicKeyPem };
    const trust = { trustedDevices: registry, ...fast };
    writeFileSync(join(dir, 'a.priv'), keyA.privateKeyPem);

    const serverA = new WsRelayServer({ port: 0, file: join(dir, 'relay-a.log'), trustedDevices: registry });
    const serverB = new WsRelayServer({ port: 0, file: join(dir, 'relay-b.log'), trustedDevices: registry });
    const portA = await serverA.start();
    const portB = await serverB.start();

    let k = await createKernel({ file: dbFile, deviceId: 'device-a', privateKeyPem: keyA.privateKeyPem });
    const ca = new WsRelayClient(`ws://127.0.0.1:${portA}`, { ...fast, maxRetries: 5, capToken: k.capToken(keyA.privateKeyPem) });
    const cb = new WsRelayClient(`ws://127.0.0.1:${portB}`, { ...fast, maxRetries: 5, capToken: k.capToken(keyA.privateKeyPem) });
    const closers: Array<() => void> = [() => ca.close(), () => cb.close(), () => k.close(), () => serverA.kill(), () => serverB.kill()];
    try {
      // Phase 1: 400 mixed multi-actor events, sync across the relay pair.
      for (let i = 0; i < 400; i++) await k.append(intentFor(i) as never);
      assert.equal(k.health().events, 400);
      const s1 = await k.sync([ca, cb], { ...trust, chunkSize: 100 });
      assert.equal(s1.acked, 400);
      assert.equal(k.ackSeq(), 400);
      assert.equal(serverA.size, 400);
      const ackedIds = new Set(serverA.storedIds());
      assert.equal(ackedIds.size, 400);

      // Phase 2: SIGKILL mid-append from a child, reopen and recover.
      k.close();
      const child = fileURLToPath(new URL('./helpers/e2e-crash-child.ts', import.meta.url));
      const proc = Bun.spawn(['bun', child, dir, '400', join(dir, 'a.priv'), '3000'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await waitFor(() => logLines(logFile).length >= 470, 60_000);
      proc.kill('SIGKILL');
      await proc.exited;

      k = await createKernel({ file: dbFile, deviceId: 'device-a', privateKeyPem: keyA.privateKeyPem });
      const durable = k.health().events;
      assert.ok(durable >= 460, `expected durable prefix past the kill point, got ${durable}`);
      const v0 = k.verifyLog() as { ok: boolean; gaps?: number[] };
      assert.equal(v0.ok, true);
      assert.deepEqual(v0.gaps ?? [], []);
      // No lost acked events: everything acked in phase 1 is still local.
      const localIds = new Set(
        (await k.query<{ id: string }>(`SELECT id FROM _events`)).map((r) => r.id),
      );
      for (const id of ackedIds) assert.ok(localIds.has(id), `lost acked event ${id}`);

      // Top up the crash slice so base intents 0..599 are all durable.
      for (let i = durable; i < 600; i++) await k.append(intentFor(i) as never);
      assert.equal(k.health().events, 600);
      const s2 = await k.sync([ca, cb], { ...trust, chunkSize: 100 });
      assert.equal(s2.acked, 200);
      assert.equal(k.ackSeq(), 600);
      assert.equal(serverA.size, 600);

      // Phase 3: undo flows — void 25 entry and 15 stock sells, history stays.
      const entryIds = (
        await k.query<{ event_id: string }>(`SELECT event_id FROM entries ORDER BY seq`)
      ).map((r) => r.event_id);
      const sellIds = (
        await k.query<{ event_id: string }>(`SELECT event_id FROM stock_moves WHERE qty < 0 AND voided = 0 ORDER BY seq`)
      ).map((r) => r.event_id);
      assert.ok(entryIds.length > 100 && sellIds.length >= 15);
      const undoEntry = [8, 38, 68, 98, 128, 158, 188, 218, 248, 278, 308, 338, 368, 398, 428, 458, 488, 518, 548, 568, 578, 588, 594, 597, 599]
        .map((n) => entryIds[n % entryIds.length]);
      const undoSell = [3, 11, 19, 27, 35, 43, 51, 59, 67, 75, 83, 91, 99, 107, 115].map((n) => sellIds[n % sellIds.length]);
      const actors = ['device-1', 'device-2', 'device-3'];
      let n = 0;
      for (const id of [...undoEntry, ...undoSell]) await k.undo(id, actors[n++ % actors.length]);
      assert.equal(k.health().events, 640);

      // Undo intent mirror: voided values leave the total, sells come back.
      let undoneValue = 0;
      for (const id of undoEntry) {
        const rows = await k.query<{ value: number }>(`SELECT value FROM entries WHERE event_id = $id`, { id });
        undoneValue += rows[0].value;
      }
      let restoredStock = 0;
      for (const id of undoSell) {
        const rows = await k.query<{ qty: number }>(`SELECT qty FROM stock_moves WHERE event_id = $id`, { id });
        restoredStock += -rows[0].qty;
      }

      // Phase 4: fill to exactly 1000 durable events.
      for (let i = 600; i < 960; i++) await k.append(intentFor(i) as never);
      assert.equal(k.health().events, TOTAL);

      // Expected end state from the deterministic intent mirror plus undos.
      const base = mirrorFor([0, 600]);
      const tail = mirrorFor([600, 960]);
      const expectEntry = base.entryTotal + tail.entryTotal - undoneValue;
      const expectStock: Record<string, number> = {};
      for (const m of [base, tail]) for (const [item, qty] of Object.entries(m.stock)) expectStock[item] = (expectStock[item] ?? 0) + qty;
      expectStock['kopi'] = (expectStock['kopi'] ?? 0) + restoredStock;

      // Phase 5: kill the primary mid-stream, finish via the secondary.
      serverA.kill();
      const s3 = await k.sync([ca, cb], { ...trust, chunkSize: 50 });
      assert.equal(s3.acked, 400);
      assert.equal(k.ackSeq(), TOTAL);
      assert.equal(s3.pushRelay, 1);
      assert.equal(s3.applied, 0);
      for (const [s, name] of [[serverA, 'a'], [serverB, 'b']] as const) {
        const ids = s.storedIds();
        assert.equal(new Set(ids).size, ids.length, `relay ${name} holds duplicates`);
      }
      const union = new Set([...serverA.storedIds(), ...serverB.storedIds()]);
      assert.equal(union.size, TOTAL);
      assert.equal(serverB.size, 400);
      // Every acked event is still in the local log: nothing lost.
      const localIds2 = new Set(
        (await k.query<{ id: string }>(`SELECT id FROM _events`)).map((r) => r.id),
      );
      for (const id of union) assert.ok(localIds2.has(id), `lost acked event ${id}`);

      // Local totals match the mirror before the revoke probe.
      const rows = await k.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
      assert.equal(rows[0].total, expectEntry);
      for (const [item, qty] of Object.entries(expectStock)) {
        const srows = await k.query<{ qty: number }>(`SELECT qty FROM stock WHERE item = $item`, { item });
        assert.equal(srows[0]?.qty ?? 0, qty, `stock ${item} mismatch`);
      }
      assert.deepEqual(await k.conflicts(), []);
      const vf = k.verifyLog() as { ok: boolean; gaps?: number[] };
      assert.equal(vf.ok, true);
      assert.deepEqual(vf.gaps ?? [], []);

      // Phase 6: capability revoke mid-stream — witness sees the tombstone,
      // the revoked device is rejected, the valid device is unaffected.
      await cb.pull(0); // witness socket is live for the broadcast
      serverB.revokeDevice('device-a');
      await waitFor(() => cb.revokedNotices.includes('device-a'));
      assert.ok(serverB.isRevoked('device-a'));
      const probe = await k.append({ type: 'entry', value: 777, actor: 'device-1' });
      await assert.rejects(k.sync(cb, { ...trust }), /rejected|forbidden|revoked/);
      assert.equal(serverB.size, 400);

      // Second device pulls both relays (per-relay cursors) and converges.
      const serverA2 = new WsRelayServer({ port: 0, file: join(dir, 'relay-a.log'), trustedDevices: registry });
      closers.push(() => serverA2.kill());
      const portA2 = await serverA2.start();
      assert.equal(serverA2.size, 600);
      const kb = await createKernel({ file: join(dir, 'b.db'), deviceId: 'device-b', privateKeyPem: keyB.privateKeyPem });
      closers.push(() => kb.close());
      const ca2 = new WsRelayClient(`ws://127.0.0.1:${portA2}`, { ...fast, maxRetries: 5, capToken: kb.capToken(keyB.privateKeyPem) });
      const cbB = new WsRelayClient(`ws://127.0.0.1:${portB}`, { ...fast, maxRetries: 5, capToken: kb.capToken(keyB.privateKeyPem) });
      closers.push(() => ca2.close(), () => cbB.close());
      const down = await kb.sync([ca2, cbB], { ...trust, chunkSize: 100 });
      assert.equal(down.applied, TOTAL);
      const kbRows = await kb.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
      assert.equal(kbRows[0].total, expectEntry); // probe 777 never left the revoked device
      for (const [item, qty] of Object.entries(expectStock)) {
        const srows = await kb.query<{ qty: number }>(`SELECT qty FROM stock WHERE item = $item`, { item });
        assert.equal(srows[0]?.qty ?? 0, qty, `peer stock ${item} mismatch`);
      }
      assert.deepEqual(await kb.conflicts(), []);
      void probe;

      // Phase 7: CLI demo totals match on its own two-device run.
      const bin = fileURLToPath(new URL('../bin/fielog.ts', import.meta.url));
      const demo = Bun.spawn(['bun', bin, 'demo'], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(demo.stdout).text(),
        new Response(demo.stderr).text(),
        demo.exited,
      ]);
      assert.equal(code, 0, `cli demo failed: ${err}`);
      assert.ok(out.includes('match on both sides, totals agree'), `cli demo totals mismatch: ${out}`);
    } finally {
      while (closers.length) {
        try {
          closers.pop()!();
        } catch {
          /* shutting down */
        }
      }
    }
  }, 180_000);
});
