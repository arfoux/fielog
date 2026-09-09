# decision log — drop-18 iou-machine

status: DROP
base: 0f89faf (v0.14.25)
suite: 142 pass, 0 fail, 46 files (`bun test`, 212.85s)

## Verdict

drop-18 iou-machine: DROP. No inter-device debt types/events are built.
Money-state completes via the existing settle/sync-ack; failed-means-failed,
not debt.

## Reasons

1. Zero inter-device debt types/events. No `hutang` / `talangan` /
   `pinjam` as event types or read-model columns. Value moves between
   devices only via existing sync events.
2. Money-state completes via settle/sync-ack. Offline only records
   DRAFT / IOU_RECORDED; SETTLED_ONLINE only via
   `payment.settled`, and FAILED / EXPIRED record the local final outcome.
   There is no fourth debt state.
3. Failed-means-failed, not debt. `payment.failed` / `payment.expired`
   are terminal, and double settle / settle-after-fail becomes a
   `double-settle` conflict for human reconciliation, not LWW.
   There is no workaround turning failure into a bill.

## File:line evidence

- test/two-device.test.js:29 — `a.append({ type: 'payment', amount: 77000 })`
  offline without relay; no debt payload.
- test/two-device.test.js:35 — `SELECT SUM(amount) ... FROM payment`
  converges on the receiver side via idempotent sync (uuid), not via
  debt events.
- demo/two-node.ts:22-34 — 20 offline transactions on device-01 then two-sided
  sync until totals match; no inter-device bridging step.
- src/store.ts:50-82 — MoneyState (DRAFT, IOU_RECORDED, SETTLED_ONLINE,
  FAILED, EXPIRED) + checkAppend rejects any payment state besides DRAFT /
  IOU_RECORDED while offline.
- src/kernel.ts:67-68 — `settle(eventId, outcome, actor)`: 'settled'
  needs an online ack; failed/expired are recorded locally.

## Written assumptions

1. One trust domain: both devices belong to the same owner.
2. Paid-in-full payment: every `payment` counts as cash settled on the spot; no
   installments, deposits, or inter-device reimbursements.

## Expiry clause

If inter-device advances become a real need (device A pays
for device B and bills later), this DROP verdict lapses. Design from the
real need then: settlement definition, evidence, and limits — not from
today's speculation.

## Verification

- `bun test` -> 142 pass, 0 fail, 46 files.
- mismatch-stop: the number/file:line claims above come only from command
  output and file reads on this machine; claim != proof -> STOP.
