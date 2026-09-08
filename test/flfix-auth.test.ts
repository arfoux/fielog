// flfix-auth: regression tests for the auth fail-closed fixes.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomUUID } from 'node:crypto';
import {
  canonicalGrant,
  checkThreshold,
  countersignEvent,
  generateDeviceKey,
  issueGrant,
  signBytes,
  verifyGrant,
} from '../src/auth.ts';
import { hashFor } from '../src/log.ts';

const NOW = 1_700_000_000_000;

const ev = (id: string) => {
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

/** Properly-signed grant with an explicit lifetime (bypasses issueGrant's now+ttl). */
function forgeGrant(
  authorityPrivatePem: string,
  deviceId: string,
  scopes: string[],
  issuedAt: number,
  expiresAt: number,
) {
  const core = { id: randomUUID(), deviceId, scopes, issuedBy: 'hq', issuedAt, expiresAt };
  return { ...core, signature: signBytes(authorityPrivatePem, canonicalGrant(core)) };
}

describe('flfix-auth: verifyGrant lifetime', () => {
  it('control: a fresh issueGrant verifies', () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey();
    const grant = issueGrant(authority.privateKeyPem, 'hq', device.deviceId, ['kasir:append'], 60_000, NOW);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', undefined, NOW), true);
  });

  it('rejects zero-TTL grant (expiresAt === issuedAt) even with a valid signature', () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey();
    const grant = forgeGrant(authority.privateKeyPem, device.deviceId, ['kasir:append'], NOW, NOW);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', undefined, NOW), false);
  });

  it('rejects inverted lifetime (expiresAt < issuedAt) even with a valid signature', () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey();
    const grant = forgeGrant(authority.privateKeyPem, device.deviceId, ['kasir:append'], NOW, NOW - 1);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', undefined, NOW - 2), false);
  });

  it('rejects use before issuance (not-before)', () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey();
    const grant = forgeGrant(authority.privateKeyPem, device.deviceId, ['kasir:append'], NOW + 60_000, NOW + 120_000);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', undefined, NOW), false);
  });

  it('accepts a grant exactly at issuance', () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey();
    const grant = forgeGrant(authority.privateKeyPem, device.deviceId, ['kasir:append'], NOW, NOW + 60_000);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', undefined, NOW), true);
  });
});

describe('flfix-auth: checkThreshold validation', () => {
  const setup = () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    const registry = new Map([
      [a.deviceId, a.publicKeyPem],
      [b.deviceId, b.publicKeyPem],
    ]);
    return { a, b, registry, e: ev('flfix') };
  };

  it('threshold 0 throws instead of vacuous truth', () => {
    const { registry, e } = setup();
    assert.throws(() => checkThreshold(registry, e, [], 0), RangeError);
  });

  it('threshold above registry size throws instead of silent false', () => {
    const { a, registry, e } = setup();
    const sigs = [countersignEvent(a.privateKeyPem, a.deviceId, e)];
    assert.throws(() => checkThreshold(registry, e, sigs, 3), RangeError);
  });

  it('negative and non-integer thresholds throw', () => {
    const { registry, e } = setup();
    assert.throws(() => checkThreshold(registry, e, [], -1), RangeError);
    assert.throws(() => checkThreshold(registry, e, [], 1.5), RangeError);
    assert.throws(() => checkThreshold(registry, e, [], Number.NaN), RangeError);
  });

  it('boundary thresholds 1 and size still work', () => {
    const { a, b, registry, e } = setup();
    const one = [countersignEvent(a.privateKeyPem, a.deviceId, e)];
    assert.deepEqual(checkThreshold(registry, e, one, 1), { valid: 1, thresholdMet: true });
    const both = [...one, countersignEvent(b.privateKeyPem, b.deviceId, e)];
    assert.deepEqual(checkThreshold(registry, e, both, 2), { valid: 2, thresholdMet: true });
    assert.deepEqual(checkThreshold(registry, e, one, 2), { valid: 1, thresholdMet: false });
  });
});

describe('flfix-auth: deviceId format', () => {
  it('default deviceId is the lowercase hex of the SPKI DER public key', () => {
    const d = generateDeviceKey();
    const der = createPublicKey(d.publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
    assert.equal(d.deviceId, (der as Buffer).toString('hex'));
  });
});
