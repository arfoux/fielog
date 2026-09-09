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
