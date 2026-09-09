# decision log — drop-18 iou-machine

status: DROP
base: 0f89faf (v0.14.25)
suite: 142 pass, 0 fail, 46 files (`bun test`, 212.85s)

## Verdict

drop-18 iou-machine: DROP. No inter-device debt types/events are built.
Money-state completes via the existing resolve/sync-ack; failed-means-failed,
not debt.

## Reasons

1. Zero inter-device debt types/events. No `hutang` / `talangan` /
   `pinjam` as event types or read-model columns. Value moves between
   devices only via existing sync events.
2. Money-state completes via resolve/sync-ack. Offline only records
   DRAFT / RECORDED; RESOLVED_ONLINE only via
   `entry.resolved`, and FAILED / EXPIRED record the local final outcome.
   There is no fourth debt state.
3. Failed-means-failed, not debt. `entry.failed` / `entry.expired`
   are terminal, and double resolve / resolve-after-fail becomes a
   `double-resolve` conflict for human reconciliation, not LWW.

## File:line evidence

- test/two-device.test.js:29 — `a.append({ type: 'entry', value: 77000 })`
  offline without relay; no debt payload.
- test/two-device.test.js:35 — `SELECT SUM(value) ... FROM entries`
  converges on the receiver side via idempotent sync (uuid), not via
  debt events.
- demo/two-node.ts:22-34 — 20 offline transactions on device-01 then two-sided
  sync until totals match; no inter-device bridging step.
- src/store.ts:50-82 — EntryState (DRAFT, RECORDED, RESOLVED_ONLINE,
  FAILED, EXPIRED) + checkAppend rejects any entry state besides DRAFT /
  RECORDED while offline.
- src/kernel.ts:67-68 — `resolve(eventId, outcome, actor)`: 'resolved'
  needs an online ack; failed/expired are recorded locally.

## Written assumptions

1. One trust domain: both devices belong to the same owner.
2. Paid-in-full entry: every `entry` counts as cash resolved on the spot; no
   installments, deposits, or inter-device reimbursements.

## Expiry clause

If inter-device advances become a real need (device A pays
for device B and bills later), this DROP verdict lapses. Design from the
real need then: resolution definition, evidence, and limits — not from
today's speculation.

## Verification

- `bun test` -> 142 pass, 0 fail, 46 files.
- mismatch-stop: the number/file:line claims above come only from command
  output and file reads on this machine; claim != proof -> STOP.

# decision log — tally rename (stock → tally)

status: DONE
base: v0.14.27

## Verdict

tally rename: DONE. Commerce-framed `stock` names are now neutral `tally`
names. Behavior is identical apart from names; no shims, no aliases.

## Reasons

1. Event types: `stock.add` → `tally.add`, `stock.sell` → `tally.remove`.
   Payload keys UNCHANGED (`{ item: string, qty: number }`);
   `tally.remove` still requires `qty > 0`.
2. Tables: `stock` → `tally` (item PK, qty), `stock_moves` → `tally_moves`
   (`seq`, `event_id` UNIQUE, `item`, signed `qty`, `voided`); all SQL
   qualifiers follow (`tally.qty`, `tally_moves` voided selects).
3. Contention kind: `oversell` → `underflow`, detail text
   `sell N×item with M on hand` → `remove N×item with M on hand`.
   A short tally parks the move as voided with an explicit conflict row —
   never silent LWW.
4. Compat history untouched: hash-chained fixtures, compat vectors, pinned
   replay shas, and CHANGELOG/model-fuzz-report bodies stay verbatim.
   The synthetic corpus sha changes (op-type bytes) and is re-measured;
   `ITEMS` / actors / op distribution are unchanged.

## File evidence

- `src/store.ts` (`checkAppend`, `route`): `tally.add` / `tally.remove`
  validation, `tally` / `tally_moves` SQL, `underflow` conflict.
- `scripts/corpus-gen.ts:51,56,82-83` — emits `tally.add` / `tally.remove`;
  manifest keys (`add` / `remove`) and `ITEMS` unchanged.
- `scripts/model-oracle.ts:47-50` — `checkOracle` reads `tally` /
  `tally_moves`; oracle method names (`add` / `remove`) unchanged.
- `docs/corpus-generator.md`, `docs/model-oracle.md` — op tables lead with
  `tally.add` / `tally.remove`; run-evidence blocks labeled pre-rename.
- `model-fuzz-report.md` — annotated with the rename, body verbatim.

## Verification
- `bun scripts/corpus-gen.ts --seed 42 --n 200 --out /tmp/corpus-tally`
  → `sha=d022597d5078 entry=97 add=40 remove=27 undo=36`, exit 0.
  Same distribution as the pre-rename base; only the sha moves with the type strings.
- `bun demo/two-node.ts` → exit 0, both sides match.
- `bun bin/fielog.ts demo` → exit 0, totals agree.
