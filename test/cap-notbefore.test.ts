import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceKey, mintCapToken, verifyCapToken, canonicalCapToken, signBytes, verifyBytes } from '../src/auth.ts';
import type { CapToken } from '../src/auth.ts';

function signFuture(dev: { privateKeyPem: string; deviceId: string }, now: number, notBefore: number): CapToken {
  const t = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], 120_000, now);
  const { signature, ...core } = t;
  void signature;
  const withNb = { ...core, notBefore };
  return { ...withNb, signature: signBytes(dev.privateKeyPem, canonicalCapToken(withNb)) };
}

describe('cap token notBefore', () => {
  it('rejects future-activation token now, accepts at/after activation', () => {
    const dev = generateDeviceKey('nb-2');
    const now = Date.now();
    const signed = signFuture(dev, now, now + 30_000);
    assert.equal(verifyBytes(dev.publicKeyPem, canonicalCapToken({ id: signed.id, deviceId: signed.deviceId, scopes: signed.scopes, issuedAt: signed.issuedAt, expiresAt: signed.expiresAt, notBefore: signed.notBefore }), signed.signature!), true);
    assert.equal(verifyCapToken(dev.publicKeyPem, signed, 'relay:push', undefined, now), false);
    assert.equal(verifyCapToken(dev.publicKeyPem, signed, 'relay:push', undefined, now + 30_000), true);
    assert.equal(verifyCapToken(dev.publicKeyPem, signed, 'relay:push', undefined, now + 31_000), true);
  });

  it('stripping notBefore breaks the signature (no strip attack)', () => {
    const dev = generateDeviceKey('nb-3');
    const now = Date.now();
    const signed = signFuture(dev, now, now + 30_000);
    const { notBefore, ...strippedCore } = signed;
    void notBefore;
    assert.equal(verifyCapToken(dev.publicKeyPem, strippedCore as CapToken, 'relay:push', undefined, now + 31_000), false);
  });

  it('tokens without notBefore still verify (backward compat)', () => {
    const dev = generateDeviceKey('nb-4');
    const now = Date.now();
    const t = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], 60_000, now);
    assert.equal(verifyCapToken(dev.publicKeyPem, t, 'relay:push', undefined, now), true);
  });
});
