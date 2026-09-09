# capability-token

Device-signed relay tokens (`CapToken`) plus authority-signed scope grants
(`ScopeGrant`): format, scope, expiry, revocation, and honest live-socket limits.

## format

`CapToken` (`src/auth.ts`):

```
{ id, deviceId, scopes, issuedAt, expiresAt, signature? }
```

- `id`: per-token UUID (`randomUUID` at mint). Revocation is granular per
  token id, never whole-device only.
- Canonical form: `canonicalCapToken` signs `{ id, deviceId, scopes(sorted),
  issuedAt, expiresAt }`. Tokens minted before the `id` field fail closed
  (`verifyCapToken` returns false) — re-mint.
- `signature`: ed25519 device signature over the canonical form. No authority
  key involved: the token is **self-signed** by the device it names.

`ScopeGrant` (`src/auth.ts`): `{ id, deviceId, scopes, issuedBy, issuedAt,
expiresAt, signature? }`, signed by the authority key over
`canonicalGrant`. Entry scopes live here, not in `CapToken`.

## scope

- Relay ops gate on `relay:push` / `relay:pull` via `verifyCapToken` /
  `authorizeCapToken`. A `relay:push`-only token is rejected for `relay:pull`.
- Entry ops gate on `entries:append` / `entries:resolve` via `verifyGrant` /
  `authorizeGrant`. The grant path is the live authorize path for entry
  scopes — grants are no longer call-site-free.
- Authorize order in `authorizeCapToken`: device tombstone → per-token-id
  revocation → signature → expiry → scope. Revoked callers never reach crypto.

## expiry (TTL)

Named constants in `src/auth.ts` (no magic numbers at call sites):

| constant          | value       | use                                  |
|-------------------|-------------|--------------------------------------|
| `GRANT_TTL_MS`    | 24 h        | `issueGrant` default                 |
| `CAP_TOKEN_TTL_MS`| 15 min      | `mintCapToken` default (short, relay-wide) |

Callers needing longer sessions pass an explicit `ttlMs`. `verifyCapToken`
also rejects `expiresAt <= issuedAt` (negative/zero TTL can never verify).

## Revoking

- Per token: `CapRevocationList.revoke(token.id)`; `verifyCapToken` and
  `authorizeCapToken({ revocations })` reject that id. Sibling tokens from
  the same device keep working.
- Per device: relay tombstone set (`WsRelayServer.revokeDevice`,
  persisted in the `.revocations` sidecar). Pass it as
  `authorizeCapToken({ revokedDevices })`; the whole device is rejected.
- Per grant: `RevocationList.revoke(grant.id)`; `authorizeGrant` rejects it.
- Rotation without redial: `WsRelayClient.setCapToken` swaps the token on
  a live socket. Mint short-lived tokens and rotate before expiry.

## Honest live-socket limits

- Self-signed means possession of a valid token equals the device key for
  its scopes until expiry or revocation. A leaked token is fully usable by
  anyone holding it — there is no binding to a socket or session.
- `live` broadcasts are hints only; `pull` is the source of truth. A token
  accepted for the socket still gets per-message scope checks on every
  push/pull — connecting does not cache authorization.
- Revocation reaches connected sockets via the `revoked` tombstone
  broadcast, but in-flight requests already authorized are not retroactively
  killed; the next push/pull is rejected.
- The relay enforces only when it knows a device (`enforcing` =
  registry non-empty). An unsigned relay accepts any `device_id` — fail
  closed in production: register a trusted device or expect forgery.
- `WsRelayServer.authorize` in `src/relay.ts` mirrors `authorizeCapToken`
  step for step; the pure function in `src/auth.ts` is the contract, the
  relay method is the wiring (read-only here, unchanged by this cure).
