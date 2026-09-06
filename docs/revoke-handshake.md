# revoke-handshake

Revoke-list handshake on every relay connect/pull (`src/relay.ts`).
Closes leak 1 of the old relay revocation: the per-relay `Set<string>`
tombstone plus the live `'revoked'` hint never reached offline devices —
a device disconnected during `revokeDevice` reconnected with a stale allow.
Here revokes are admin-signed events (`src/revokelog.ts`, read-only contract)
and every `push`/`pull` first runs a bidirectional cursor handshake, so an
offline device replays what it missed on reconnect.

## wire (`revoke_pull` / `revoke_push`)

| dir | op | payload | reply |
|---|---|---|---|
| c->s | `revoke_pull` | `{ req, cursor }` | `revoke_res { req, events, cursor }` or `error bad_cursor` |
| c->s | `revoke_push` | `{ req, events }` | `revoke_ack { req, added, skipped, rejected, cursor }` |

Both ops bypass the capability gate and the chaos drop: events authenticate
themselves (admin ed25519 over the content hash), merge is idempotent by
hash, and a revoked device must still learn its own revocation. Forgeries
(stranger admin, transplanted signature, dangling `prev`) count as
`rejected` and are never stored; the channel is not poisoned — the next
legit event still merges.

## flow (`WsRelayClient.syncRevokes`)

```
pull = await revoke_pull(serverCursor)   # relay tail since last handshake
local.merge(pull.events)                 # idempotent; rejected never stored
serverCursor = pull.cursor
ack = await revoke_push(local.diffSince(upTo).events)
upTo = local.size                        # offered; replay always safe
pull again + merge                       # concurrent relay writes converge in one call
```

Stale cursor (relay restarted from an older file) falls back to a full
snapshot merge from `0`. `push()`/`pull()` run this best-effort before the
data op: revoke state is a hint, the data pull stays the source of truth,
so a handshake failure never breaks sync — the next connect/pull retries
idempotently.

## policy (derived, never stored)

- Per token: `isTokenRevoked(id)` iff some event for `id` carries an
  equal-or-higher epoch. The relay rejects `push`/`pull` whose
  `token.id` is revoked (`token revoked: <id>`); siblings with fresh ids
  keep working. Re-issuing means minting a higher epoch; `CapToken` ids
  are random UUIDs with no epoch, so any event for the id kills it.
- Whole device: some event with `tokenId '*'` naming the device.
  `isRevoked()` / `revokedIds()` return the union of the legacy tombstone
  set and the log-derived rows, so `revokeDevice` keeps working and
  handshake revokes enforce through the same gate.

Persistence: `file.revoke-events` JSONL (one signed event per line,
fsync before ack), reloaded by idempotent merge on boot; the legacy
`.revocations` sidecar still loads. Counters: `revokePullsReceived`,
`revokePushesReceived`, `revokeRejected` (server), `revokeSyncs`,
`revokeRejected` (client).

## evidence (`test/handshake-revoke.test.ts`)

Offline replay (revoke lands while the device is disconnected; the
reconnect handshake replays it, the dead token is then rejected while a
fresh sibling works), divergent converge (relay tok-2 + client tok-1 meet
in one `syncRevokes` to byte-equal snapshots, second sync adds 0),
forgery reject (stranger admin + transplanted signature count as rejected
wire-side and client-side, never stored, legit revoke converges after).

```
bun test test/handshake-revoke.test.ts   # 3 pass, 0 fail
```
