# fielog changelog

All entries describe user-visible changes shipped under each tag, in tag order.
Untagged commits are folded into the next tag that shipped them.

## Unreleased

(No unreleased changes yet.)

## v0.15.0 — truncate guards, fail-closed gates, relay budgets

- Retention: `truncate()` guarded by `guardSeal` — sweep stops at the acked/applied prefix, skips legally-held events, and never splits a tombstone hide/show pair; report names held events and pairs that blocked the rest.
- Read-model: tamper gate fails closed on hash mismatch (no silent merge of edited payloads); swept UUIDs recorded in `_swept_ids` so re-appending an excised id throws instead of forking log vs store.
- Hash chain: `verifyChain` checks seq continuity plus hash/prev linkage, with `opts.base`/`opts.startSeq` to pin a post-sweep base (foreign `prev_hash` hints at `log.verify()` instead of failing cryptic).
- Quota wired: `createKernel({ quotaLimitBytes })` reserves per append and throws `ERR_QUOTA_EXCEEDED`/`ERR_QUOTA_UNKNOWN` fail-closed before anything is written; `kernel.quota()` reports usage.
- Relay budgets: per-batch event-count and per-event byte caps on push, revoke push, and raw frames; pull paginated with count + total-byte caps (client walks pages to the global cursor); oversized startup file refused loud instead of OOMing; byte sizes measured in UTF-8, not UTF-16 length.
- Auth: `CapToken.notBefore` activation floor (early token fails closed); corrupt delta-sync resume/dead-set meta throws instead of silently refetching or resurrecting poison.
- Surface: `health()`/`verifyLog()` expose `skipped` poison lines (open-time replay warns `WARN_REPLAY_SKIPPED`); CAS quarantine persisted in the manifest (`has` hides quarantined keys, `stat` reports the sidecar, `gc` skips them); tombstone `show` atomic with same-replica check; snapshot lock file serializes cross-process writers (`ERR_SNAPSHOT_IN_FLIGHT`); torn-tail repair fsyncs file + dir.
- Compat: interop-seal test skips when the sibling checkout is absent (green CI without it).
- Bench (2026-09-12, slice fa03a62, bun 1.4.0): append 262/s (p50 3.06 ms, p99 7.89 ms); that cost is fsync-per-append + SQLite apply — durability, not overhead. Full numbers in `docs/bench.md`, the single source of truth.
- Decisions: `docs/decisions.md` records five standing calls (epoch-less token reissue, `dist/` out of scope, plaintext relay behind WireGuard, no claim engine here, dated single-source bench pins).

## v0.13.0–v0.14.26 — folded (no per-tag notes; untagged waves per the rule above)

- Auth: granular per-token capabilities (named TTLs) enforced per operation; revoke event log with convergent merge, revoke handshake on every relay connect/pull, revoke quarantine + retroactive purge on sync.
- Storage: sha-keyed CAS store (refcount, quarantine); tombstone soft-delete engine with GC guard + legal hold; quota guard with reserve + fail-closed admission.
- Sync: manifest-first delta sync (want-list resume, UUID idempotency); hash-chain-log facade with quarantine + re-anchor.
- Compat: v0.5 fixtures + conformance runner (writer superset rule).
- Rig & harness: two-device rig, seeded corpus + corruption generators, bench-honesty doc + check script, cold-drill log-only recovery, model oracle, soak runner, chaos-kill drill, flake-hunter, pre-merge conformance gate, watchdog, mismatch-stop, completion protocol, ff-only merge runner.
- Audit + perf waves: typecheck clean (`PushResult` exported, relay rng field, CAS writeSync narrowing); 30 audit suspects fixed (relay fail-closed persist — no ack for unwritten events, ack only stored ids; store seq-vs-id collision no longer swallowed; fractional value rejected; sync dead-letter cursors; retain empty-guard returns 0; revokelog convergent tie-break; tombstone guard covers show/target; quota remaining clamped; canonical payload key order; duplicate-id append rejected; seq-gap verification; device mismatch throws with first-explicit adoption; threshold misconfig throws; CAS orphan sweep + EEXIST tolerance + fstat + guarded quarantine; deltasync real dead-letter list + honest fetched metric); kernel split healing O(1) steady-state; relay liveBuf dedup via persistent Set, token verdicts cached per revoke size, incremental `purgeRevoked`, deterministic backoff jitter by default. Suite: 218 tests green, tsc clean.
## v0.14.27 — docs, gallery, universal wire keys

- Wire keys universalized (no commerce terms): `entry`/`value`/`tally`/`resolve`, device ids; English CLI/demo/scripts/tests narrative (schema field `oleh` kept, fixtures kept).
- Docs: README is now the entry point + index; one concern per topic page (install,
  quickstart, architecture, kernel-api, sync-protocol, relay, retention,
  auth, contracts, cli, limits-troubleshooting), API tables verified against `src/`.
- New: `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` (solo/small-team).
- Bench: full numbers in `docs/bench.md` (single source of truth for figures).
- Repo: lean tarball (no docs), OIDC tag-publish provenance, byte-exact fixtures via gitattributes.

- Gallery: 8 APNG explainers + logo in README (docs/gifs/, outside the tarball).
## v0.1.0 — offline kernel

- Initial release: offline-first `createKernel({ file })` with `append` / `query` / `undo`, no network needed for local writes.
- Append-only JSONL log with a sha256 hash chain per event (`GENESIS` anchor, `tail -f` friendly).
- SQLite read-model via `bun:sqlite` (plain SQLite file, opens in external tools); money honesty rule (offline money is only RECORDED, resolution needs online ack) and fail-fast `checkAppend` so rejected writes leave no log line behind.
- Device identity: per-device keypairs, event signing/verification, scope grants, countersignatures with threshold check, revocation list.
- Sync core: `MemoryRelay`, `pushPending` / `pullRemote` / `syncKernel` with ack-cursor resume and backoff; open conflicts queryable via `kernel.conflicts()`; `undo` as compensating events.

## v0.2.0 — real ws relay

- `WsRelayServer` / `WsRelayClient`: real websocket transport over `Bun.serve`, no extra dependencies.
- Client reconnects with backoff and jitter and resumes from the ack cursor; server live-broadcasts arrivals as a hint (pull stays the source of truth) with heartbeat ping/pong.

## v0.3.0 — hardening and clock skew

- Corrupt log lines are quarantined to `<log>.quarantine` (with forensics) instead of failing open; torn tail writes from a mid-append kill are truncated on open and reported via `repairedTail`.
- Wall clocks are display-only: `ts_device` never decides order, `kernel` accepts an injectable `clock`, and ordering stays on the monotonic seq even with 30-minute device skew.
- New `kernel.health()` (`events`, `quarantined`, `repairedTail`, `gaps`) and `verifyLog()` gap reporting for re-anchored seqs.
- `kill9` tests fixed to run from any working directory; new `demo/two-node.ts` (20 offline sales, then two-device sync with equal totals).

## v0.4.0 — relay survives restart

- Relay persists every stored event to a JSONL file before acking; kill and restart resumes exact-once by event UUID from the client ack cursor.
- Stress coverage with 10 concurrent clients; README rewritten as operator docs.

## v0.5.0 — snapshot, truncate, atomic apply

- Retention: `kernel.snapshot(dest)` captures the read-model plus sealed seq; `kernel.truncate()` sweeps the sealed log prefix behind a `fielog-truncate` marker that chains the kept suffix to the removed prefix.
- Atomic apply: a kill between log append and read-model apply can no longer orphan an event; reopen replays the log into the store idempotently.

## v0.6.0 — cli

- New `bin/fielog.ts`: `serve --port <n> --file <relay.log>` runs a file-backed ws relay, `sync --file <ledger.db> --relay <ws url>` pushes and pulls a kernel file's delta, `demo` runs the two-node roundtrip and proves equal totals.

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
- `undo` (and `resolve`) targeting an event that has not arrived yet parks and resurrects: the compensation applies once the target arrives late instead of being lost.

## v0.10.0 — ack implies stored

- The ack cursor only advances over events the relay actually acknowledged, closing the ack-without-store hole.
- `truncate` clamps the seal to the stored and acked prefix, so a sweep can no longer delete unacked or unapplied data (stale seals become safe no-ops).

## v0.11.0 — review highs, failover stripe

- Kernel appends are signed; per-relay pull cursors; CLI signed by default.
- Failover stripe backfills the acked prefix on relay switch.

## v0.12.0 — release hygiene

- MIT license, pack files list, README install quickstart + docs links.
- CLI die race fixed: sync stderr write before exit; signed serve documented.
