# revoke-event-log

Revoke as an authenticated event-log convergent across relays
(`src/revokelog.ts`). Closes leaks 1+2 of the old relay revocation: it was
an unauthenticated per-relay `Set<string>` (relay.ts `revoked` + live
`'revoked'` hint) with no cross-relay merge. Here every revoke is an
admin-signed event; replicas sync by idempotent set-union merge.

## format (`RevokeEvent`)

| field | meaning |
|---|---|
| `v` | `1` (rejects anything else) |
| `tokenId` | revoked capability/grant id; `'*'` = whole-device revoke |
| `deviceId` | token owner whose capability dies |
| `epoch` | monotonic per tokenId; higher supersedes lower |
| `admin` | signer deviceId; must be in the trusted admin registry |
| `issuedAt` | wall clock, display only — never authoritative |
| `prev` | chain link: `REVOKE-GENESIS` or a known event hash (audit hint) |
| `hash` | sha256 over `canonicalRevoke` (core without hash/sig/id) |
| `sig` | admin ed25519 signature over `hash` (`auth.ts` signBytes) |
| `id` | `= hash` (idempotency key) |

Effective state is derived, never stored: `isRevoked(tokenId, tokenEpoch)`
is true iff some event for that tokenId has `epoch >= tokenEpoch`.
`revokedTokens()` keeps one row per tokenId at its max epoch.

## api (`src/revokelog.ts`)

| op | symbol | meaning |
|---|---|---|
| create | `createRevokeEvent(adminPrivPem, admin, input, prev?, now?)` | build + admin-sign one event |
| append | `log.create(priv, admin, input)` / `log.append(event)` | verified single append; throws on forgery, `'duplicate'` on replay |
| verify | `verifyRevokeEvent(reg, e)` / `verifyRevokeChain(reg, events)` / `log.verify()` | content hash + known admin + signature + no dangling `prev` (DAG check, order-free — concurrent writers fork the `prev` hint) |
| snapshot | `log.snapshot()` | canonical view sorted by `(epoch, hash)`; byte-equal across replicas after full merge |
| diff | `log.diffSince(cursor)` | first-seen suffix after cursor; cursor = `order.length` |
| merge | `log.merge(remote)` | idempotent set-union `{ added, skipped, rejected }`; commutative, unordered batches resolve to a fixpoint |

Cursor discipline: only diff your own log (append-only, cursor stays
stable); cross-replica sync is `merge(snapshot)` — set union needs no
cursor. Forged or dangling-`prev` events count as `rejected` and are never
stored. `REVOKE_GENESIS` is the empty-log tip and first-`prev` value.

## handshake contract (wave-B)

The handshake task consumes exactly this surface; no other coupling:

```
# A (relay) holds RevokeLog(admins); B (handshake peer) holds RevokeLog(same admins).
out = A.diffSince(cursorA)        # A's own unseen tail; cursorA = A's order.length
res = B.merge(out.events)         # idempotent; res.rejected counts forgeries, never stored
back = B.diffSince(cursorB)       # B's own unseen tail
A.merge(back.events)              # converges: A.snapshot() deep-equals B.snapshot()
```

Token check after sync: `log.isRevoked(token.id, token.epoch)` — a token
dies iff a revoke for its id carries an equal-or-higher epoch. Re-issuing a
capability means minting it at a higher epoch; older revokes stop matching.
`'*'` rows kill every epoch of that device (`isRevoked('*')` is not
special-cased — match device rows explicitly in the handshake policy).

## evidence (`test/revokelog.test.ts`)

Divergent pair (A: tok-1@1 + tok-3@2, B: tok-2@1) converges to byte-equal
snapshots after bidirectional merge, `verify()` OK on both; opposite-order
merge on a fresh pair lands on the same snapshot. Replay of a full snapshot
adds 0 / skips all; forged admin id, transplanted signature, and unknown
admin all throw and merge-reject without storing. Cursor diff returns the
unseen suffix only (`0 -> 3`, `2 -> [tok-3]`, `3 -> []`), bad cursor throws,
peer tail pulls exactly the one new event.

```
bun test test/revokelog.test.ts   # 4 pass, 0 fail
```
