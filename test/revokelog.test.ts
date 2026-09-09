// revokelog: revoke as an authenticated event-log convergent across relays.
// Convergent divergent pair, idempotent replay, forged reject, cursor diff.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { generateDeviceKey } from '../src/auth.ts';
import {
  RevokeLog,
  createRevokeEvent,
  verifyRevokeChain,
  verifyRevokeEvent,
} from '../src/revokelog.ts';

function adminRig(id = 'admin-1'): { admin: ReturnType<typeof generateDeviceKey>; registry: Map<string, string> } {
  const admin = generateDeviceKey(id);
  return { admin, registry: new Map([[admin.deviceId, admin.publicKeyPem]]) };
}

describe('revoke-event-log', () => {
  it('divergent replicas converge after bidirectional merge', () => {
    const { admin, registry } = adminRig();
    const a = new RevokeLog(registry);
    const b = new RevokeLog(registry);
    // Divergent writes: same genesis base, neither side sees the other.
    const e1 = a.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-1', deviceId: 'device-01', epoch: 1 });
    const e2 = b.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-2', deviceId: 'device-02', epoch: 1 });
    const e3 = a.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-3', deviceId: 'device-01', epoch: 2 });
    assert.equal(e3.prev, e1.hash); // local chain threads the local tip

    assert.deepEqual(a.merge(b.snapshot()), { added: 1, skipped: 0, rejected: 0 });
    assert.deepEqual(b.merge(a.snapshot()), { added: 2, skipped: 1, rejected: 0 });
    assert.deepEqual(a.snapshot(), b.snapshot());
    assert.deepEqual(a.verify(), { ok: true });
    assert.deepEqual(b.verify(), { ok: true });
    for (const t of ['tok-1', 'tok-2', 'tok-3']) {
      assert.ok(a.isRevoked(t) && b.isRevoked(t), `${t} revoked on both`);
    }

    // Commutative: fresh pair merged in opposite batch order lands identical.
    const c = new RevokeLog(registry);
    const d = new RevokeLog(registry);
    c.merge([e2, e1, e3]);
    d.merge([e3, e2, e1]);
    assert.deepEqual(c.snapshot(), d.snapshot());
    assert.deepEqual(c.snapshot(), a.snapshot());
  });

  it('replay is idempotent', () => {
    const { admin, registry } = adminRig();
    const log = new RevokeLog(registry);
    log.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-1', deviceId: 'device-01', epoch: 1 });
    log.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-2', deviceId: 'device-02', epoch: 1 });
    const snap = log.snapshot();
    assert.deepEqual(log.merge(snap), { added: 0, skipped: 2, rejected: 0 });
    assert.equal(log.append({ ...snap[0] }), 'duplicate');
    assert.equal(log.size, 2);
    assert.deepEqual(log.snapshot(), snap);
  });

  it('forged events are rejected, never stored', () => {
    const { admin, registry } = adminRig();
    const attacker = generateDeviceKey('attacker');
    const log = new RevokeLog(registry);

    // Attacker key signs for the admin id: signature cannot verify.
    const forged = createRevokeEvent(attacker.privateKeyPem, admin.deviceId, {
      tokenId: 'tok-9',
      deviceId: 'device-09',
      epoch: 1,
    });
    assert.equal(verifyRevokeEvent(registry, forged), false);
    assert.throws(() => log.append(forged), /revoke rejected/);

    // Valid signature transplanted onto an edited epoch: hash mismatch.
    const good = createRevokeEvent(admin.privateKeyPem, admin.deviceId, {
      tokenId: 'tok-9',
      deviceId: 'device-09',
      epoch: 1,
    });
    assert.equal(verifyRevokeEvent(registry, good), true);
    assert.equal(verifyRevokeEvent(registry, { ...good, epoch: 7 }), false);
    assert.throws(() => log.append({ ...good, epoch: 7 }), /revoke rejected/);

    // Unknown admin: well-formed and self-signed, but not trusted.
    const stranger = createRevokeEvent(attacker.privateKeyPem, attacker.deviceId, {
      tokenId: 'tok-9',
      deviceId: 'device-09',
      epoch: 1,
    });
    assert.throws(() => log.append(stranger), /revoke rejected/);

    assert.equal(log.size, 0);
    assert.deepEqual(log.merge([forged, stranger, { ...good, epoch: 7 }]), {
      added: 0,
      skipped: 0,
      rejected: 3,
    });
    assert.deepEqual(verifyRevokeChain(registry, [forged]), { ok: false, at: forged.id, reason: 'bad admin signature' });
  });

  it('cursor diff returns only the unseen suffix', () => {
    const { admin, registry } = adminRig();
    const log = new RevokeLog(registry);
    log.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-1', deviceId: 'device-01', epoch: 1 });
    log.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-2', deviceId: 'device-02', epoch: 1 });
    log.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-3', deviceId: 'device-01', epoch: 2 });

    const d0 = log.diffSince(0);
    assert.equal(d0.events.length, 3);
    assert.equal(d0.cursor, 3);
    const d2 = log.diffSince(2);
    assert.equal(d2.events.length, 1);
    assert.equal(d2.events[0].tokenId, 'tok-3');
    assert.equal(d2.cursor, 3);
    assert.deepEqual(log.diffSince(3).events, []);
    assert.throws(() => log.diffSince(99), /bad cursor/);

    // Peer syncs, appends once, origin pulls only the new tail.
    const peer = new RevokeLog(registry);
    assert.deepEqual(peer.merge(log.snapshot()), { added: 3, skipped: 0, rejected: 0 });
    peer.create(admin.privateKeyPem, admin.deviceId, { tokenId: 'tok-4', deviceId: 'device-02', epoch: 2 });
    assert.deepEqual(log.merge(peer.diffSince(3).events), { added: 1, skipped: 0, rejected: 0 });
    assert.equal(log.diffSince(3).events[0].tokenId, 'tok-4');
    assert.equal(log.diffSince(4).cursor, 4);
  });
});
