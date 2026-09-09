// auth.ts — ed25519 device keys, revocable scopes, countersign threshold.
// No PKI: devices are raw public keys; an authority key signs scope grants.
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { canonicalOf, hashFor, type LogEvent } from './log.js';
/**
 * Device identity.
 *
 * `deviceId` is the lowercase hex encoding of the ed25519 public key's
 * SPKI DER bytes (`publicKey.export({ type: 'spki', format: 'der' })`
 * rendered as hex). Registry maps, scope grants, capability tokens, and
 * countersignatures key on this exact string — never the PEM. An explicit
 * `deviceId` override (e.g. a named authority such as 'hq' in tests)
 * bypasses the derivation and is NOT SPKI-DER hex; production devices
 * always use the derived form.
 */
export interface DeviceKeypair {
  deviceId: string; // lowercase hex of the ed25519 public key (SPKI DER)
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateDeviceKey(deviceId?: string): DeviceKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return {
    deviceId: deviceId ?? (pubDer as Buffer).toString('hex'),
    publicKeyPem: pubPem,
    privateKeyPem: privPem,
  };
}

export function signBytes(privateKeyPem: string, data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return sign(null, bytes, privateKeyPem).toString('hex');
}

export function verifyBytes(publicKeyPem: string, data: Uint8Array | string, signatureHex: string): boolean {
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return verify(null, bytes, publicKeyPem, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Sign the event's hash-chain hash: signature covers the whole causal history. */
export function signEvent(privateKeyPem: string, ev: LogEvent): string {
  return signBytes(privateKeyPem, ev.hash);
}

export function verifyEvent(publicKeyPem: string, ev: LogEvent, signatureHex: string): boolean {
  const { hash } = ev;
  // Recompute the chain hash so a signature can't be transplanted onto edited bytes.
  // The auth envelope itself is never hashed (signature covers the hash).
  const { hash: _drop, signature: _s, countersignatures: _c, ...core } = ev;
  void _drop;
  void _s;
  void _c;
  if (hashFor(core) !== hash) return false;
  return verifyBytes(publicKeyPem, hash, signatureHex);
}

// Named TTLs: single source for grant/capability lifetimes. The relay path
// uses the short capability default; callers needing longer sessions pass
// an explicit ttlMs rather than forking a second magic number.
export const GRANT_TTL_MS = 24 * 3600 * 1000;
export const CAP_TOKEN_TTL_MS = 15 * 60 * 1000;

 // Scopes: revocable capability grants signed by an authority key.
export interface ScopeGrant {
  id: string;
  deviceId: string;
  scopes: string[]; // e.g. ['payment:append', 'payment:settle']
  issuedBy: string; // authority deviceId / name
  issuedAt: number;
  expiresAt: number;
  signature?: string; // authority signature over the canonical grant
}

export function canonicalGrant(g: Omit<ScopeGrant, 'signature'>): string {
  return JSON.stringify({
    id: g.id,
    deviceId: g.deviceId,
    scopes: [...g.scopes].sort(),
    issuedBy: g.issuedBy,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
  });
}

export function issueGrant(
  authorityPrivatePem: string,
  issuedBy: string,
  deviceId: string,
  scopes: string[],
  ttlMs = GRANT_TTL_MS,
  now = Date.now(),
): ScopeGrant {
  const grant: Omit<ScopeGrant, 'signature'> = {
    id: randomUUID(),
    deviceId,
    scopes,
    issuedBy,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  return { ...grant, signature: signBytes(authorityPrivatePem, canonicalGrant(grant)) };
}

export class RevocationList {
  private revoked = new Set<string>(); // grant ids; dynamic membership → Set
  revoke(grantId: string): void {
    this.revoked.add(grantId);
  }
  isRevoked(grantId: string): boolean {
    return this.revoked.has(grantId);
  }
  get size(): number {
    return this.revoked.size;
  }
}

export function verifyGrant(
  authorityPublicPem: string,
  grant: ScopeGrant,
  scope: string,
  revocations?: RevocationList,
  now = Date.now(),
): boolean {
  if (!grant.signature) return false;
  if (grant.expiresAt <= grant.issuedAt) return false; // malformed lifetime: fail closed
  if (now < grant.issuedAt) return false; // not-before: usable only from issuance
  if (now > grant.expiresAt) return false;
  if (revocations?.isRevoked(grant.id)) return false;
  const { signature, ...core } = grant;
  if (!verifyBytes(authorityPublicPem, canonicalGrant(core), signature)) return false;
  return grant.scopes.includes(scope);
}

// Capability tokens: the device key itself signs a scope+expiry token.
// The relay holds a deviceId -> publicKey registry and verifies the
// signature + scope + expiry on every push/pull. No authority key involved.
// Self-signed limit: possession of a valid token equals the device key for
// its scopes until expiry or revocation — see docs/capability-token.md.

export interface CapToken {
  id: string; // per-token id: revocation is granular, never whole-device only
  deviceId: string;
  scopes: string[]; // e.g. ['relay:push', 'relay:pull']
  issuedAt: number;
  expiresAt: number;
  signature?: string; // device signature over the canonical token
}

export function canonicalCapToken(t: Omit<CapToken, 'signature'>): string {
  return JSON.stringify({
    id: t.id,
    deviceId: t.deviceId,
    scopes: [...t.scopes].sort(),
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt,
  });
}

export function mintCapToken(
  privateKeyPem: string,
  deviceId: string,
  scopes: string[],
  ttlMs = CAP_TOKEN_TTL_MS,
  now = Date.now(),
): CapToken {
  const core: Omit<CapToken, 'signature'> = {
    id: randomUUID(),
    deviceId,
    scopes,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  return { ...core, signature: signBytes(privateKeyPem, canonicalCapToken(core)) };
}

/** Per-token-id revocation for capability tokens (granular: one token dies, siblings live). */
export class CapRevocationList {
  private revoked = new Set<string>(); // token ids; dynamic membership → Set
  revoke(tokenId: string): void {
    this.revoked.add(tokenId);
  }
  isRevoked(tokenId: string): boolean {
    return this.revoked.has(tokenId);
  }
  get size(): number {
    return this.revoked.size;
  }
}

export function verifyCapToken(
  publicKeyPem: string,
  token: CapToken,
  scope: string,
  revocations?: CapRevocationList,
  now = Date.now(),
): boolean {
  if (!token.signature) return false;
  if (!token.id) return false; // id-less legacy token: fail closed, re-mint
  if (token.expiresAt <= token.issuedAt) return false;
  if (now > token.expiresAt) return false;
  if (revocations?.isRevoked(token.id)) return false;
  const { signature, ...core } = token;
  if (!verifyBytes(publicKeyPem, canonicalCapToken(core), signature)) return false;
  return token.scopes.includes(scope);
}

export type AuthorizeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Authorize a relay op against a capability token: device tombstone first,
 * then per-token-id revocation, signature, expiry, and scope — in that order
 * so revoked callers never reach crypto. This is the authorize path the relay
 * mirrors (see WsRelayServer.authorize in src/relay.ts, read-only here).
 */
export function authorizeCapToken(opts: {
  publicKeyPem: string | undefined;
  token: CapToken | undefined;
  scope: string;
  revocations?: CapRevocationList;
  revokedDevices?: Set<string> | string[];
  now?: number;
}): AuthorizeVerdict {
  const now = opts.now ?? Date.now();
  if (!opts.token) return { ok: false, reason: 'missing capability token' };
  const revoked = opts.revokedDevices instanceof Set ? opts.revokedDevices : new Set(opts.revokedDevices ?? []);
  if (revoked.has(opts.token.deviceId)) return { ok: false, reason: `device revoked: ${opts.token.deviceId}` };
  if (!opts.publicKeyPem) return { ok: false, reason: `unknown device: ${opts.token.deviceId}` };
  if (!verifyCapToken(opts.publicKeyPem, opts.token, opts.scope, opts.revocations, now)) {
    return { ok: false, reason: `capability rejected for ${opts.scope}` };
  }
  return { ok: true };
}

/**
 * Authorize a payment-scoped op against an authority-signed grant. Wires the
 * previously call-site-free verifyGrant into the authorize path so payment
 * scopes (payment:append, payment:settle) are gated per grant id, not assumed.
 */
export function authorizeGrant(opts: {
  authorityPublicPem: string;
  grant: ScopeGrant | undefined;
  scope: string;
  revocations?: RevocationList;
  now?: number;
}): AuthorizeVerdict {
  const now = opts.now ?? Date.now();
  if (!opts.grant) return { ok: false, reason: 'missing scope grant' };
  if (!verifyGrant(opts.authorityPublicPem, opts.grant, opts.scope, opts.revocations, now)) {
    return { ok: false, reason: `grant rejected for ${opts.scope}` };
  }
  return { ok: true };
}

// Countersign: high-value moves need ≥ threshold distinct authorized signatures.

export interface Countersignature {
  deviceId: string;
  signatureHex: string;
}

export function countersignEvent(privateKeyPem: string, deviceId: string, ev: LogEvent): Countersignature {
  return { deviceId, signatureHex: signEvent(privateKeyPem, ev) };
}

export function checkThreshold(
  registry: Map<string, string>, // deviceId -> publicKeyPem
  ev: LogEvent,
  signatures: Countersignature[],
  threshold: number,
): { valid: number; thresholdMet: boolean } {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > registry.size) {
    throw new RangeError(`checkThreshold: threshold ${threshold} out of range 1..${registry.size}`);
  }
  const seen = new Set<string>();
  let valid = 0;
  for (const s of signatures) {
    if (seen.has(s.deviceId)) continue; // one vote per device
    const pub = registry.get(s.deviceId);
    if (!pub) continue; // unknown device: not a vote
    if (!verifyEvent(pub, ev, s.signatureHex)) continue;
    seen.add(s.deviceId);
    valid += 1;
  }
  return { valid, thresholdMet: valid >= threshold };
}

export { canonicalOf };
