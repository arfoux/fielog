// handshake-revoke: revoke-list handshake on every connect/pull.
// Offline devices replay missed revokes on reconnect, divergent replicas
// converge by idempotent merge, forged events are rejected and never stored.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';
import { generateDeviceKey, mintCapToken } from '../src/auth.ts';
import { createRevokeEvent } from '../src/revokelog.ts';

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

function adminRig(): { admin: ReturnType<typeof generateDeviceKey>; admins: Record<string, string> } {
  const admin = generateDeviceKey('admin-1');
  return { admin, admins: { [admin.deviceId]: admin.publicKeyPem } };
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-hsrev-'));
  const { admin, admins } = adminRig();
  const devA = generateDeviceKey('kasir-a');
  const devB = generateDeviceKey('kasir-b');
  const server = new WsRelayServer({
    port: 0,
    file: join(dir, 'relay.log'),
    trustedDevices: { [devA.deviceId]: devA.publicKeyPem, [devB.deviceId]: devB.publicKeyPem },
    revokeAdmins: admins,
  });
  closers.push(() => server.kill());
  const port = await server.start();
  const url = `ws://127.0.0.1:${port}`;
  return { dir, admin, admins, devA, devB, server, url };
}

function clientFor(url: string, dev: ReturnType<typeof generateDeviceKey>, admins: Record<string, string>, scopes = ['relay:push', 'relay:pull']) {
  const c = new WsRelayClient(url, {
    ...fast,
    capToken: mintCapToken(dev.privateKeyPem, dev.deviceId, scopes),
    revokeAdmins: admins,
  });
  closers.push(() => c.close());
  return c;
}

describe('revoke handshake', () => {
  it('offline device replays missed revokes on reconnect and is then rejected', async () => {
    const { admin, admins, devA, devB, server, url } = await rig();
    const online = clientFor(url, devA, admins);
    closers.push(() => online.close());
    // Victim token minted before the revoke lands; the device stays offline.
    const victim = mintCapToken(devB.privateKeyPem, devB.deviceId, ['relay:push', 'relay:pull']);
    const offline = new WsRelayClient(url, { ...fast, capToken: victim, revokeAdmins: admins });
    closers.push(() => offline.close());

    await online.pull(0); // online peer establishes its revoke cursor
    server.issueRevoke(admin.privateKeyPem, admin.deviceId, { tokenId: victim.id, deviceId: devB.deviceId, epoch: 1 });
    assert.equal(server.isTokenRevoked(victim.id), true);

    // Reconnect: the handshake replays the missed revoke even though the
    // dead token can no longer move data.
    const hs = await offline.syncRevokes();
    assert.equal(hs.rejected, 0);
    assert.equal(offline.isTokenRevoked(victim.id), true);
    assert.deepEqual(offline.revokeSnapshot(), server.revokeSnapshot());
    await assert.rejects(offline.push([]), /rejected|forbidden|revoked/);
    // ...while a sibling token minted after the revoke keeps working.
    offline.setCapToken(mintCapToken(devB.privateKeyPem, devB.deviceId, ['relay:push', 'relay:pull']));
    const ack = await offline.push([]);
    assert.deepEqual(ack.acked, []);
  }, 30_000);

  it('divergent replicas converge to byte-equal snapshots with idempotent replay', async () => {
    const { admin, admins, server, url } = await rig();
    const c = clientFor(url, generateDeviceKey('kasir-a'), admins);

    // Divergent writes while the socket is idle: one revoke lands on the
    // relay, one is authored into the client log; neither side sees the other.
    server.issueRevoke(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-2', deviceId: 'kasir-02', epoch: 1 });
    c.revokes.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-1', deviceId: 'kasir-01', epoch: 1 });

    const first = await c.syncRevokes();
    assert.equal(first.added >= 2, true);
    assert.equal(first.rejected, 0);
    assert.deepEqual(c.revokeSnapshot(), server.revokeSnapshot());
    assert.deepEqual(server.revokes.verify(), { ok: true });
    assert.deepEqual(c.revokes.verify(), { ok: true });
    assert.ok(c.isTokenRevoked('tok-1') && c.isTokenRevoked('tok-2'));

    // Replay is idempotent: a second handshake adds nothing.
    const again = await c.syncRevokes();
    assert.equal(again.added, 0);
    assert.equal(again.rejected, 0);
    assert.deepEqual(c.revokeSnapshot(), server.revokeSnapshot());
  }, 30_000);

  it('forged handshake events are rejected and never stored', async () => {
    const { admin, admins, server, url } = await rig();
    const c = clientFor(url, generateDeviceKey('kasir-a'), admins);
    const attacker = generateDeviceKey('attacker');
    const base = server.revokeCursor();

    // Unknown admin: well-formed and self-signed, but not trusted.
    const stranger = createRevokeEvent(attacker.privateKeyPem, attacker.deviceId, {
      tokenId: 'tok-x',
      deviceId: 'kasir-01',
      epoch: 1,
    });
    // Transplanted signature: valid admin sig over edited content.
    const good = createRevokeEvent(admin.privateKeyPem, admin.deviceId, {
      tokenId: 'tok-y',
      deviceId: 'kasir-01',
      epoch: 1,
    });
    const transplanted = { ...good, epoch: 7 };

    // Wire-level: the relay counts both as rejected and stores nothing.
    const ack = await c.pushRevokes([stranger, transplanted]);
    assert.equal(ack.rejected, 2);
    assert.equal(ack.added, 0);
    assert.equal(server.revokeCursor(), base);

    // Client-level: local merge refuses them too.
    const m = c.revokes.merge([stranger, transplanted]);
    assert.equal(m.rejected, 2);
    assert.equal(c.revokes.size, 0);

    // The channel is not poisoned: a legit revoke still converges after.
    server.issueRevoke(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-ok', deviceId: 'kasir-01', epoch: 1 });
    const res = await c.syncRevokes();
    assert.equal(res.rejected, 0);
    assert.deepEqual(c.revokeSnapshot(), server.revokeSnapshot());
    assert.ok(c.isTokenRevoked('tok-ok'));
    assert.equal(c.isTokenRevoked('tok-x'), false);
  }, 30_000);
});
