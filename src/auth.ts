// auth.ts — ed25519 device keys, revocable scopes, countersign threshold.
// No PKI: devices are raw public keys; an authority key signs scope grants.
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { canonicalOf, hashFor, type LogEvent } from './log.js';
export interface DeviceKeypair {
  deviceId: string; // hex of the ed25519 public key (SPKI DER)
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
  const { hash: _drop, ...core } = ev;
  void _drop;
  if (hashFor(core) !== hash) return false;
  return verifyBytes(publicKeyPem, hash, signatureHex);
}

// Scopes: revocable capability grants signed by an authority key.

export interface ScopeGrant {
  id: string;
  deviceId: string;
  scopes: string[]; // e.g. ['kasir:append', 'kasir:settle']
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
  ttlMs = 24 * 3600 * 1000,
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
  const { signature, ...core } = grant;
  if (!verifyBytes(authorityPublicPem, canonicalGrant(core), signature)) return false;
  if (now > grant.expiresAt) return false;
  if (revocations?.isRevoked(grant.id)) return false;
  return grant.scopes.includes(scope);
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
