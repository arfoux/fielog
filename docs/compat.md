# compat: v0.5 log format

Reader and writer both keep backward compat with the v0.5-era `ledger.log`.

## v0.5 event fields (required)

`id, seq, type, device_id, ts_device, payload, prev_hash, hash`.
One JSON object per line, `seq` monotonic from 1, `prev_hash` chains to
`GENESIS` on seq 1. Reference: `test/fixtures/v05-ledger.log` (5 events,
hand-written, minimal fields, no new features).

## superset rule (writer)

Current writer output MUST be `v0.5 fields + known-optional only`.
Known-optional today: `actor, origin_seq, origin_device, server_time`.
Rules for any new event field:

1. OPTIONAL: old logs without it replay cleanly (reader uses `??` /
   null-tolerant defaults, never throws on absence).
2. UNHASHED, or null-tolerant like `actor`: stripping unknown-optional
   fields MUST still verify (`hashFor` over the v0.5 core equals `hash`),
   so a v0.5 reader can check integrity. `canonicalOf` (src/log.ts) is
   the frozen list — adding a hashed field breaks old readers.
3. NEVER required, never renamed, never repurposed.

## proof

`test/compat-v05.test.ts`: opens the v0.5 fixture in a fresh kernel,
checks `verifyLog()`, replays into the read-model (entry total 40000,
kopi tally 97), appends seq 6 chained on the fixture tip, then asserts
every written line carries all v0.5 fields, no unknown fields, and
hash-verifies with optional fields stripped.
