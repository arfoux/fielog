// Relay capability enforcement: device-signed scope+expiry tokens verified
// on every push/pull; revocations broadcast as tombstones and persisted.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';
import { generateDeviceKey, mintCapToken } from '../src/auth.ts';

const fast = { baseMs: 1, maxMs: 30 };

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function rejectsRelay(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, /rejected|forbidden|revoked/);
}

describe('relay capabilities', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()!();
      } catch {
        /* gone */
      }
    }
  });

  it('forged token rejected on push and pull', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cap-'));
    const dev = generateDeviceKey('kasir-a');
    const attacker = generateDeviceKey('attacker');
    const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log') });
    server.registerDevice(dev.deviceId, dev.publicKeyPem);
    closers.push(() => server.kill());
    const port = await server.start();

    const k = await createKernel({ file: join(dir, 'a.db'), deviceId: dev.deviceId });
    closers.push(() => k.close());
    // Attacker key signs for the victim device id: signature cannot verify.
    const forged = mintCapToken(attacker.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull']);
    const c = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast, capToken: forged });
    closers.push(() => c.close());

    await k.append({ type: 'bayar', nominal: 1000, oleh: 'toko' });
    await rejectsRelay(k.sync(c, { ...fast }));
    await rejectsRelay(c.pull(0));
    assert.equal(server.size, 0);
    assert.ok(server.rejectsReceived >= 2);
  }, 30_000);

  it('expired token rejected on push and pull', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cap-'));
    const dev = generateDeviceKey('kasir-a');
    const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log') });
    server.registerDevice(dev.deviceId, dev.publicKeyPem);
    closers.push(() => server.kill());
    const port = await server.start();

    const k = await createKernel({ file: join(dir, 'a.db'), deviceId: dev.deviceId });
    closers.push(() => k.close());
    const expired = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull'], -1000);
    const c = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast, capToken: expired });
    closers.push(() => c.close());

    await k.append({ type: 'bayar', nominal: 500, oleh: 'toko' });
    await rejectsRelay(k.sync(c, { ...fast }));
    await rejectsRelay(c.pull(0));
    assert.equal(server.size, 0);
  }, 30_000);

  it('revoked device rejected after revoke broadcast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cap-'));
    const devA = generateDeviceKey('kasir-a');
    const devB = generateDeviceKey('kasir-b');
    const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log') });
    server.registerDevice(devA.deviceId, devA.publicKeyPem);
    server.registerDevice(devB.deviceId, devB.publicKeyPem);
    closers.push(() => server.kill());
    const port = await server.start();

    const ka = await createKernel({ file: join(dir, 'a.db'), deviceId: devA.deviceId });
    closers.push(() => ka.close());
    const ca = new WsRelayClient(`ws://127.0.0.1:${port}`, {
      ...fast,
      capToken: ka.capToken(devA.privateKeyPem),
    });
    closers.push(() => ca.close());
    const cb = new WsRelayClient(`ws://127.0.0.1:${port}`, {
      ...fast,
      capToken: mintCapToken(devB.privateKeyPem, devB.deviceId, ['relay:push', 'relay:pull']),
    });
    closers.push(() => cb.close());

    // Both connected: baseline push works, witness pull establishes its socket.
    await ka.append({ type: 'bayar', nominal: 100, oleh: 'toko' });
    const up = await ka.sync(ca, { ...fast });
    assert.equal(up.acked, 1);
    await cb.pull(0);

    server.revokeDevice(devA.deviceId);

    // Tombstone reaches the connected witness.
    await waitFor(() => cb.revokedNotices.includes(devA.deviceId));

    await ka.append({ type: 'bayar', nominal: 200, oleh: 'toko' });
    await rejectsRelay(ka.sync(ca, { ...fast }));
    await rejectsRelay(ca.pull(0));
    assert.ok(server.isRevoked(devA.deviceId));
  }, 30_000);

  it('valid device unaffected and revocation survives relay restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cap-'));
    const file = join(dir, 'relay.log');
    const devA = generateDeviceKey('kasir-a');
    const devB = generateDeviceKey('kasir-b');
    const trusted = { [devA.deviceId]: devA.publicKeyPem, [devB.deviceId]: devB.publicKeyPem };
    const server = new WsRelayServer({ port: 0, file, trustedDevices: trusted });
    closers.push(() => server.kill());
    const port = await server.start();

    const kb = await createKernel({ file: join(dir, 'b.db'), deviceId: devB.deviceId });
    closers.push(() => kb.close());
    const cb = new WsRelayClient(`ws://127.0.0.1:${port}`, {
      ...fast,
      capToken: kb.capToken(devB.privateKeyPem),
    });
    closers.push(() => cb.close());

    server.revokeDevice(devA.deviceId);

    // Valid device keeps pushing and pulling through the revocation.
    await kb.append({ type: 'bayar', nominal: 700, oleh: 'toko' });
    const up = await kb.sync(cb, { ...fast });
    assert.equal(up.acked, 1);
    const down = await kb.sync(cb, { ...fast });
    assert.equal(down.applied, 0);

    // Restart on the same file: the revoke list reloads from the sidecar.
    server.kill();
    const server2 = new WsRelayServer({ port, file, trustedDevices: trusted });
    closers.push(() => server2.kill());
    await server2.start();
    assert.deepEqual(server2.revokedIds(), [devA.deviceId]);

    const ka = await createKernel({ file: join(dir, 'a.db'), deviceId: devA.deviceId });
    closers.push(() => ka.close());
    const ca = new WsRelayClient(`ws://127.0.0.1:${port}`, {
      ...fast,
      capToken: ka.capToken(devA.privateKeyPem),
    });
    closers.push(() => ca.close());
    await ka.append({ type: 'bayar', nominal: 50, oleh: 'toko' });
    await rejectsRelay(ka.sync(ca, { maxRetries: 3, ...fast }));

    await kb.append({ type: 'bayar', nominal: 51, oleh: 'toko' });
    const up2 = await kb.sync(cb, { maxRetries: 20, ...fast });
    assert.equal(up2.acked, 1);
    assert.equal(server2.size, 2);
  }, 30_000);
});
