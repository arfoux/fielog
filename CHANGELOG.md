# fielog changelog

All entries describe user-visible changes shipped under each tag, in tag order.
Untagged commits are folded into the next tag that shipped them.

## v0.1.0 — offline kernel

- Initial release: offline-first `createKernel({ file })` with `append` / `query` / `undo`, no network needed for local writes.
- Append-only JSONL log with a sha256 hash chain per event (`GENESIS` anchor, `tail -f` friendly).
- SQLite read-model via `bun:sqlite` (plain SQLite file, opens in external tools); money honesty rule (offline money is an IOU, settlement needs online ack) and fail-fast `checkAppend` so rejected writes leave no log line behind.
- Device identity: per-device keypairs, event signing/verification, scope grants, countersignatures with threshold check, revocation list.
- Sync core: `MemoryRelay`, `pushPending` / `pullRemote` / `syncKernel` with ack-cursor resume and backoff; open conflicts queryable via `kernel.conflicts()`; `undo` as compensating events.

## v0.2.0 — real ws relay

- `WsRelayServer` / `WsRelayClient`: real websocket transport over `Bun.serve`, no extra dependencies.
- Client reconnects with backoff and jitter and resumes from the ack cursor; server live-broadcasts arrivals as a hint (pull stays the source of truth) with heartbeat ping/pong.

## v0.3.0 — hardening and clock skew

- Corrupt log lines are quarantined to `<log>.quarantine` (with forensics) instead of failing open; torn tail writes from a mid-append kill are truncated on open and reported via `repairedTail`.
- Wall clocks are display-only: `ts_device` never decides order, `kernel` accepts an injectable `clock`, and ordering stays on the monotonic seq even with 30-minute device skew.
- New `kernel.health()` (`events`, `quarantined`, `repairedTail`, `gaps`) and `verifyLog()` gap reporting for re-anchored seqs.
- `kill9` tests fixed to run from any working directory; new `demo/kasir-2hp.ts` (20 offline sales, then two-device sync with equal totals).

## v0.4.0 — relay survives restart

- Relay persists every stored event to a JSONL file before acking; kill and restart resumes exact-once by event UUID from the client ack cursor.
- Stress coverage with 10 concurrent clients; README rewritten as operator docs.

## v0.5.0 — snapshot, truncate, atomic apply

- Retention: `kernel.snapshot(dest)` captures the read-model plus sealed seq; `kernel.truncate()` sweeps the sealed log prefix behind a `fielog-truncate` marker that chains the kept suffix to the removed prefix.
- Atomic apply: a kill between log append and read-model apply can no longer orphan an event; reopen replays the log into the store idempotently.

## v0.6.0 — cli

- New `bin/fielog.ts`: `serve --port <n> --file <relay.log>` runs a file-backed ws relay, `sync --file <kasir.db> --relay <ws url>` pushes and pulls a kernel file's delta, `demo` runs the two-device kasir roundtrip and proves equal totals.

## v0.7.0 — relay capability tokens

- Relays can require capability tokens: `kernel.capToken(privateKeyPem, scopes, ttlMs)` mints push/pull-scoped tokens, the server verifies and enforces them per operation.
- Revoked devices are broadcast to connected clients and token state persists across relay restarts.

## v0.8.0 — failover and bounded outbox

- `kernel.sync` accepts an ordered relay list: failing relays cool down with backoff, get re-probed, and the list order decides fail-back.
- Bounded outbox: `append` refuses with `ERR_OUTBOX_FULL` once unsynced events reach the cap (default 50_000, tunable via `maxPending`), so an offline device fails fast instead of growing unbounded.

## v0.9.0 — v0.5 log compat

- Forward-compat guarantee: v0.5-era log files replay byte-for-byte on the current build (fixture test), with the writer superset rule documented in `docs/compat.md`.

## v0.9.1 — poison, forgery, late undo

- Poison pull events are quarantined instead of wedging sync in a livelock; the cursor advances past them.
- Pull events whose origin signature does not verify against the trusted device key are rejected.
- `undo` (and `settle`) targeting an event that has not arrived yet parks and resurrects: the compensation applies once the target arrives late instead of being lost.

## v0.10.0 — ack implies stored

- The ack cursor only advances over events the relay actually acknowledged, closing the ack-without-store hole.
- `truncate` clamps the seal to the stored and acked prefix, so a sweep can no longer delete unacked or unapplied data (stale seals become safe no-ops).
