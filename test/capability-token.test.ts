// Capability tokens: expiry, per-token-id revocation, scope gating.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  CAP_TOKEN_TTL_MS,
  GRANT_TTL_MS,
  CapRevocationList,
  RevocationList,
  authorizeCapToken,
  authorizeGrant,
  generateDeviceKey,
  issueGrant,
  mintCapToken,
  verifyCapToken,
  verifyGrant,
} from '../src/auth.ts';

describe('capability tokens (granular per-token-id)', () => {
  it('accepts a valid token for its scope', async () => {
    const dev = generateDeviceKey('kasir-a');
    const now = Date.now();
    const token = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull'], CAP_TOKEN_TTL_MS, now);
    assert.ok(token.id.length > 0);
    assert.equal(token.expiresAt - token.issuedAt, CAP_TOKEN_TTL_MS);
    assert.equal(verifyCapToken(dev.publicKeyPem, token, 'relay:push', undefined, now), true);
    assert.deepEqual(authorizeCapToken({ publicKeyPem: dev.publicKeyPem, token, scope: 'relay:pull', now }), { ok: true });
  });

  it('rejects an expired token', async () => {
    const dev = generateDeviceKey('kasir-a');
    const now = Date.now();
    const expired = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], CAP_TOKEN_TTL_MS, now - CAP_TOKEN_TTL_MS - 1000);
    assert.equal(verifyCapToken(dev.publicKeyPem, expired, 'relay:push', undefined, now), false);
    const verdict = authorizeCapToken({ publicKeyPem: dev.publicKeyPem, token: expired, scope: 'relay:push', now });
    assert.equal(verdict.ok, false);
  });

  it('rejects a revoked token id while a sibling token lives', async () => {
    const dev = generateDeviceKey('kasir-a');
    const now = Date.now();
    const dead = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], CAP_TOKEN_TTL_MS, now);
    const live = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], CAP_TOKEN_TTL_MS, now);
    assert.notEqual(dead.id, live.id);
    const rev = new CapRevocationList();
    rev.revoke(dead.id);
    assert.equal(verifyCapToken(dev.publicKeyPem, dead, 'relay:push', rev, now), false);
    assert.equal(verifyCapToken(dev.publicKeyPem, live, 'relay:push', rev, now), true);
  });

  it('rejects a device-tombstoned token at the authorize gate', async () => {
    const dev = generateDeviceKey('kasir-a');
    const now = Date.now();
    const token = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], CAP_TOKEN_TTL_MS, now);
    const verdict = authorizeCapToken({
      publicKeyPem: dev.publicKeyPem,
      token,
      scope: 'relay:push',
      revokedDevices: new Set([dev.deviceId]),
      now,
    });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /revoked/);
  });

  it('gates scope: wrong scope rejected at verify and authorize', async () => {
    const dev = generateDeviceKey('kasir-a');
    const now = Date.now();
    const pushOnly = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], CAP_TOKEN_TTL_MS, now);
    assert.equal(verifyCapToken(dev.publicKeyPem, pushOnly, 'relay:pull', undefined, now), false);
    assert.equal(authorizeCapToken({ publicKeyPem: dev.publicKeyPem, token: pushOnly, scope: 'relay:pull', now }).ok, false);
  });

  it('gates kasir scopes through the grant authorize path', async () => {
    const authority = generateDeviceKey('authority');
    const device = generateDeviceKey('kasir-a');
    const now = Date.now();
    const grant = issueGrant(authority.privateKeyPem, 'hq', device.deviceId, ['kasir:append'], GRANT_TTL_MS, now);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:append', undefined, now), true);
    assert.equal(verifyGrant(authority.publicKeyPem, grant, 'kasir:settle', undefined, now), false);
    assert.equal(
      authorizeGrant({ authorityPublicPem: authority.publicKeyPem, grant, scope: 'kasir:settle', now }).ok,
      false,
    );
    const rev = new RevocationList();
    rev.revoke(grant.id);
    assert.equal(authorizeGrant({ authorityPublicPem: authority.publicKeyPem, grant, scope: 'kasir:append', revocations: rev, now }).ok, false);
  });
});
