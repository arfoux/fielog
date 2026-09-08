// Auth: device keys sign events, grants scope them, threshold gates big moves.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  generateDeviceKey,
  signEvent,
  verifyEvent,
  issueGrant,
  verifyGrant,
  RevocationList,
  countersignEvent,
  checkThreshold,
} from '../src/auth.ts';
import { hashFor } from '../src/log.ts';

const ev = (id) => {
  const core = {
    id,
    seq: 1,
    type: 'bayar',
    device_id: 'd1',
    ts_device: 1,
    payload: { nominal: 1000 },
    prev_hash: 'GENESIS',
  };
  return { ...core, hash: hashFor(core) };
};

describe('auth', () => {
  it('sign / verify round-trips; transplanted signature fails', async () => {
    const d = generateDeviceKey();
    const sig = signEvent(d.privateKeyPem, ev('e1'));
    assert.ok(verifyEvent(d.publicKeyPem, ev('e1'), sig));
    assert.equal(verifyEvent(d.publicKeyPem, ev('e2'), sig), false);
  });

  it('grants gate scopes and revocation kills them', async () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey();
    const grant = issueGrant(authority.privateKeyPem, 'hq', device.deviceId, ['kasir:append']);
    assert.ok(verifyGrant(authority.publicKeyPem, grant, 'kasir:append'));
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:settle'), false);
    const rev = new RevocationList();
    rev.revoke(grant.id);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', rev), false);
  });

  it('countersign threshold counts distinct valid devices', async () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    const c = generateDeviceKey();
    const stranger = generateDeviceKey();
    const registry = new Map([
      [a.deviceId, a.publicKeyPem],
      [b.deviceId, b.publicKeyPem],
      [c.deviceId, c.publicKeyPem],
    ]);
    const e = ev('big');
    const sigs = [countersignEvent(a.privateKeyPem, a.deviceId, e), countersignEvent(b.privateKeyPem, b.deviceId, e)];
    assert.deepEqual(checkThreshold(registry, e, sigs, 2), { valid: 2, thresholdMet: true });
    // Unknown device + duplicate vote don't count.
    const padded = [...sigs, countersignEvent(stranger.privateKeyPem, stranger.deviceId, e), sigs[0]];
    assert.deepEqual(checkThreshold(registry, e, padded, 3), { valid: 2, thresholdMet: false });
  });
});
