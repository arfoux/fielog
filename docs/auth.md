# auth

Device identity, signing, and revocation (`src/auth.ts`). Token deep dive:
[capability-token](capability-token.md); revocation handshake:
[revoke-handshake](revoke-handshake.md), [revoke-event-log](revoke-event-log.md).

## API

```ts
interface DeviceKeypair { deviceId: string; publicKeyPem: string; privateKeyPem: string }
generateDeviceKey(deviceId?: string): DeviceKeypair; // ed25519; default id = hex pubkey
signBytes(privateKeyPem, data): string; verifyBytes(publicKeyPem, data, signatureHex): boolean;
signEvent(privateKeyPem, ev): string;  // signs over the chain hash (covers the full causal history)
verifyEvent(publicKeyPem, ev, signatureHex): boolean;
GRANT_TTL_MS = 24 h; CAP_TOKEN_TTL_MS = 15 min;
interface ScopeGrant { id, deviceId, scopes, issuedBy, issuedAt, expiresAt, signature? }
issueGrant(authorityPrivPem, issuedBy, deviceId, scopes, ttlMs?, now?): ScopeGrant;
verifyGrant(authorityPubPem, grant, scope, revocations?, now?): boolean;
class RevocationList { revoke(id): void; isRevoked(id): boolean }
interface CapToken { id, deviceId, scopes, issuedAt, expiresAt, signature? }
mintCapToken(privateKeyPem, deviceId, scopes, ttlMs?, now?): CapToken; // self-signed by the device
verifyCapToken(publicKeyPem, token, scope, revocations?, now?): boolean;
class CapRevocationList { revoke(tokenId): void; isRevoked(tokenId): boolean }
authorizeCapToken({ publicKeyPem, token, scope, revocations?, revokedDevices?, now? }): AuthorizeVerdict;
authorizeGrant({ authorityPublicPem, grant, scope, revocations?, now? }): AuthorizeVerdict;
countersignEvent(privateKeyPem, deviceId, ev): Countersignature;
checkThreshold(registry, ev, signatures, threshold): { valid, thresholdMet };
```

## Model

- No PKI: a device is a raw pubkey. The authority signs scope grants;
  devices self-sign their own capability tokens.
- Relay scopes (`relay:push` / `relay:pull`) vs kasir scopes
  (`kasir:append` / `kasir:settle`): different gates
  (`verifyCapToken`/`authorizeCapToken` vs `verifyGrant`/`authorizeGrant`).
- Token authorize order: device tombstone → per-token-id revocation →
  signature → expiry → scope. A revoked caller never reaches crypto.
- Self-signed = holding a valid token equals holding the device key until
  expiry or revocation; not bound to a socket. A leaked token is usable by
  anyone holding it. Keep TTLs short (15 minutes) + rotate via
  `WsRelayClient.setCapToken` without redial.
- A relay enforces only when it knows a device (`enforcing` = non-empty
  registry). An unsigned relay accepts any `device_id` — local dev only.
- `bayar` with nominal >= limit needs `threshold` distinct countersignatures
  (`SyncOpts.highValue`, verified on pull).
