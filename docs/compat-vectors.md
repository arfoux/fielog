# compat vectors (HEALTHY): cross-version read-write conformance

`test/compat-vectors.test.ts` pins five conformance vectors over the frozen
v0.5 fixtures in `test/fixtures/v0.5/` (`ledger-minimal.log`, 5 events;
`ledger-actor.log`, 4 events with the null-tolerant `actor` optional).
New kernel must read old logs (read) and old readers must still verify new
tails after stripping known-optional fields (cross-write). Superset rule:
see `docs/compat.md` (`canonicalOf` in `src/log.ts` is the frozen hashed list).

| vector | name | check |
|---|---|---|
| S | seq | fixture seqs contiguous from 1, `prev_hash` chains from `GENESIS` |
| E | event fields | every line carries all v0.5 fields, nothing outside v0.5 + known-optional (`actor, origin_seq, origin_device, server_time`) |
| H | hash | every line verifies under `hashFor`; stripping optional fields still verifies (old-reader simulation) |
| A | append | kernel appends onto the fixture tip (`seq N+1`, `prev_hash` = tip), `verifyLog()` stays ok, new tail strip-verifies |
| T | tolerant replay | old log replays into the read-model (`ledger-minimal`: payment 2/40000, kopi 97; `ledger-actor`: payment 2/15000, gula 47) |

## proof

`bun test test/compat-vectors.test.ts` — 5 pass, 0 fail.
Full suite after adding the vectors: 96 pass, 0 fail, 37 files
(base 69681b0 was 91 pass, 0 fail, 36 files).
