# auth

Identitas device, tanda, dan revoke (`src/auth.ts`). Pendalaman token:
[capability-token](capability-token.md); handshake revoke:
[revoke-handshake](revoke-handshake.md), [revoke-event-log](revoke-event-log.md).

## API

```ts
interface DeviceKeypair { deviceId: string; publicKeyPem: string; privateKeyPem: string }
generateDeviceKey(deviceId?: string): DeviceKeypair; // ed25519; default id = hex pubkey
signBytes(privateKeyPem, data): string; verifyBytes(publicKeyPem, data, signatureHex): boolean;
signEvent(privateKeyPem, ev): string;  // tanda atas hash rantai (mencakup seluruh riwayat kausal)
verifyEvent(publicKeyPem, ev, signatureHex): boolean;
GRANT_TTL_MS = 24 jam; CAP_TOKEN_TTL_MS = 15 menit;
interface ScopeGrant { id, deviceId, scopes, issuedBy, issuedAt, expiresAt, signature? }
issueGrant(authorityPrivPem, issuedBy, deviceId, scopes, ttlMs?, now?): ScopeGrant;
verifyGrant(authorityPubPem, grant, scope, revocations?, now?): boolean;
class RevocationList { revoke(id): void; isRevoked(id): boolean }
interface CapToken { id, deviceId, scopes, issuedAt, expiresAt, signature? }
mintCapToken(privateKeyPem, deviceId, scopes, ttlMs?, now?): CapToken; // self-signed oleh device
verifyCapToken(publicKeyPem, token, scope, revocations?, now?): boolean;
class CapRevocationList { revoke(tokenId): void; isRevoked(tokenId): boolean }
authorizeCapToken({ publicKeyPem, token, scope, revocations?, revokedDevices?, now? }): AuthorizeVerdict;
authorizeGrant({ authorityPublicPem, grant, scope, revocations?, now? }): AuthorizeVerdict;
countersignEvent(privateKeyPem, deviceId, ev): Countersignature;
checkThreshold(registry, ev, signatures, threshold): { valid, thresholdMet };
```

## model

- Tanpa PKI: device = pubkey mentah. Otoritas menandatangani grant scope;
  device menandatangani sendiri token kapabilitasnya.
- Scope relay (`relay:push` / `relay:pull`) vs scope kasir
  (`kasir:append` / `kasir:settle`): gerbang berbeda
  (`verifyCapToken`/`authorizeCapToken` vs `verifyGrant`/`authorizeGrant`).
- Urutan authorize token: tombstone device → revoke per-token-id →
  tanda → expiry → scope. Caller terevoke tidak pernah sampai ke crypto.
- Self-signed = kepemilikan token valid setara kunci device sampai expiry
  atau revoke; tidak terikat socket. Token bocor = bisa dipakai siapa pun
  yang memegangnya. Minta pendek (15 menit) + rotasi via
  `WsRelayClient.setCapToken` tanpa redial.
- Relay hanya enforce bila mengenal device (`enforcing` = registry
  non-kosong). Relay unsigned menerima `device_id` apa pun — dev lokal saja.
- `bayar` nominal >= limit butuh `threshold` countersignature berbeda
  (`SyncOpts.highValue`, diverifikasi di pull).
