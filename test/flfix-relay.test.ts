// flfix-relay: regression tests for the relay.ts audit fixes.
// (1) null-fd push fails closed, (2) push_ack carries only stored ids,
// (3) send() never throws, (4) syncRevokes carries no echo tail,
// (5) liveBuf is bounded, (6) double start is rejected,
// (7) authorize/revoke_push avoid per-message snapshot sorts.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsRelayServer, WsRelayClient, MAX_LIVE_HINTS } from '../src/relay.ts';
import { RevokeLog } from '../src/revokelog.ts';
import { generateDeviceKey, mintCapToken } from '../src/auth.ts';
import type { LogEvent } from '../src/log.ts';

const fast = { baseMs: 1, maxMs: 30 };

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) {
    const fn = closers.pop();
    try {
      fn?.();
    } catch {
      /* closing */
    }
  }
});

// Real sockets: fake timers cannot drive ws i/o, so poll for the awaited
// condition with a deadline instead of sleeping a fixed duration.
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

let seq = 0;
function mkEv(id: string): LogEvent {
  seq += 1;
  return {
    id,
    seq,
    type: 'bayar',
    device_id: 'kasir-test',
    ts_device: Date.now(),
    payload: { nominal: 100 },
    prev_hash: 'GENESIS',
    hash: `hash-${id}`,
  };
}

function openServer(opts: ConstructorParameters<typeof WsRelayServer>[0] = {}) {
  const server = new WsRelayServer({ port: 0, ...opts });
  closers.push(() => server.kill());
  return server;
}

function openClient(url: string, extra: Record<string, unknown> = {}) {
  const c = new WsRelayClient(url, { ...fast, ...extra });
  closers.push(() => c.close());
  return c;
}

describe('flfix-relay', () => {
  it('null-fd push fails closed: unwritten events are never acked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-nullfd-'));
    const file = join(dir, 'relay.log');
    const server = openServer({ file });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`);
    const ev = mkEv('fl-nullfd-1');

    // Test-only seam: reach the private fd to simulate a lost log handle.
    const serverSeam: { logFd: number | null } = server as unknown as { logFd: number | null };
    serverSeam.logFd = null;

    await assert.rejects(c.push([ev]), /persist|rejected/);
    assert.equal(server.storedIds().includes(ev.id), false, 'unpersisted event must not look stored');
    assert.equal(readFileSync(file, 'utf8').includes(ev.id), false, 'unpersisted event must not reach disk');
  }, 30_000);

  it('push_ack carries only actually-stored ids, duplicates still resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-ack-'));
    const server = openServer({ file: join(dir, 'relay.log') });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`);

    const a = mkEv('fl-ack-a');
    const dup = mkEv('fl-ack-dup');
    const ack1 = await c.push([a, dup, { ...dup }]);
    assert.deepEqual(ack1.acked, [a.id, dup.id], 'intra-batch repeat collapses to one stored ack');
    const b = mkEv('fl-ack-b');
    assert.deepEqual((await c.push([a, b])).acked, [a.id, b.id]);
    // Full re-push of already-stored events still acks them: crash-resume
    // must advance, never stall on an empty ack.
    assert.deepEqual((await c.push([a, b])).acked, [a.id, b.id]);
    assert.equal(server.size, 3);
  }, 30_000);

  it('send() never throws on a dead socket', () => {
    const server = openServer();
    const dead = {
      send(_s: string): void {
        throw new Error('socket gone');
      },
    };
    // Test-only seam: reach the private sender with a throwing socket.
    const sender: { send(ws: typeof dead, msg: { op: string }): void } = server as unknown as {
      send(ws: typeof dead, msg: { op: string }): void;
    };
    assert.doesNotThrow(() => sender.send(dead, { op: 'ping' }));
  });

  it('syncRevokes carries no echo tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-echo-'));
    const admin = generateDeviceKey('admin-1');
    const admins = { [admin.deviceId]: admin.publicKeyPem };
    const dev = generateDeviceKey('kasir-a');
    const server = openServer({
      file: join(dir, 'relay.log'),
      trustedDevices: { [dev.deviceId]: dev.publicKeyPem },
      revokeAdmins: admins,
    });
    const port = await server.start();
    const url = `ws://127.0.0.1:${port}`;
    const c = openClient(url, {
      capToken: mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull']),
      revokeAdmins: admins,
    });

    server.issueRevoke(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-1', deviceId: 'kasir-01', epoch: 1 });
    const first = await c.syncRevokes();
    assert.equal(first.added, 1);
    assert.equal(first.skipped, 0, 'first handshake must not echo the absorbed server tail');
    assert.deepEqual(c.revokeSnapshot(), server.revokeSnapshot());

    server.issueRevoke(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-2', deviceId: 'kasir-02', epoch: 1 });
    const second = await c.syncRevokes();
    assert.equal(second.added, 1);
    assert.equal(second.skipped, 0, 'steady-state handshake re-pushes nothing the relay already stores');
    assert.deepEqual(c.revokeSnapshot(), server.revokeSnapshot());
  }, 30_000);

  it('liveBuf is bounded while pull stays the source of truth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-live-'));
    const server = openServer({ file: join(dir, 'relay.log') });
    const port = await server.start();
    const url = `ws://127.0.0.1:${port}`;
    const a = openClient(url);
    const b = openClient(url);
    // Connect b first so it witnesses every live broadcast as a hint.
    assert.deepEqual(await b.pull(0), { events: [], cursor: 0 });

    const total = MAX_LIVE_HINTS * 4;
    const chunk = 200;
    for (let i = 0; i < total; i += chunk) {
      const batch: LogEvent[] = [];
      for (let j = 0; j < chunk; j++) batch.push(mkEv(`fl-live-${i + j}`));
      await a.push(batch);
    }
    await waitFor(() => b.liveCount >= MAX_LIVE_HINTS);
    // No completion signal exists for fire-and-forget live broadcasts, so
    // settle briefly: the assertion is an upper bound, and the buffer only
    // grows here, so extra settling can never flake a bounded buffer.
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    setTimeout(settle, 300);
    await settled;
    assert.ok(b.liveCount <= MAX_LIVE_HINTS, `liveBuf grew to ${b.liveCount}, cap is ${MAX_LIVE_HINTS}`);
    assert.equal(server.size, total);
  }, 30_000);

  it('double start is rejected and the first server keeps working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-start-'));
    const server = openServer({ file: join(dir, 'relay.log') });
    const port = await server.start();
    await assert.rejects(server.start(), /already started/);
    const c = openClient(`ws://127.0.0.1:${port}`);
    const ack = await c.push([mkEv('fl-start-1')]);
    assert.deepEqual(ack.acked, ['fl-start-1']);
  }, 30_000);

  it('gated push with an empty revoke log sorts nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-nosort-'));
    const dev = generateDeviceKey('kasir-a');
    const server = openServer({
      file: join(dir, 'relay.log'),
      trustedDevices: { [dev.deviceId]: dev.publicKeyPem },
    });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`, {
      capToken: mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull']),
    });

    let sorts = 0;
    const orig = RevokeLog.prototype.snapshot;
    RevokeLog.prototype.snapshot = function (this: RevokeLog) {
      sorts += 1;
      return orig.call(this);
    };
    try {
      const ack = await c.push([mkEv('fl-nosort-1')]);
      assert.deepEqual(ack.acked, ['fl-nosort-1']);
      assert.equal(sorts, 0, `empty-log gate sorted the revoke log ${sorts} time(s)`);
    } finally {
      RevokeLog.prototype.snapshot = orig;
    }
  }, 30_000);

  it('revoke_push persists the fresh tail with no snapshot sort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-rpush-'));
    const admin = generateDeviceKey('admin-1');
    const admins = { [admin.deviceId]: admin.publicKeyPem };
    const dev = generateDeviceKey('kasir-a');
    const server = openServer({
      file: join(dir, 'relay.log'),
      trustedDevices: { [dev.deviceId]: dev.publicKeyPem },
      revokeAdmins: admins,
    });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`, {
      capToken: mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull']),
      revokeAdmins: admins,
    });

    const ev = c.revokes.create(admin.privateKeyPem, admin.deviceId, {
      tokenId: 'tok-fresh',
      deviceId: 'kasir-09',
      epoch: 1,
    });

    let sorts = 0;
    const orig = RevokeLog.prototype.snapshot;
    RevokeLog.prototype.snapshot = function (this: RevokeLog) {
      sorts += 1;
      return orig.call(this);
    };
    try {
      const ack = await c.pushRevokes([ev]);
      assert.deepEqual({ added: ack.added, skipped: ack.skipped, rejected: ack.rejected }, { added: 1, skipped: 0, rejected: 0 });
      assert.equal(sorts, 0, `revoke_push sorted the revoke log ${sorts} time(s)`);
    } finally {
      RevokeLog.prototype.snapshot = orig;
    }
    assert.equal(server.revokeCursor(), 1);
    assert.ok(readFileSync(join(dir, 'relay.log.revoke-events'), 'utf8').includes(ev.hash));
  }, 30_000);
});
