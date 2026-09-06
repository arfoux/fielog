# quarantine

Local revoke quarantine + retroactive purge (`src/sync.ts`). Closes leak 3:
pull used to converge blindly — a revoked device's bytes landed in the read
views like any other event, and pre-revoke data kept serving forever after
the revoke arrived.

## philosophy

Quarantine closes ACCESS and keeps EVIDENCE. It never rewrites or deletes
the append-only log: the tainted bytes stay on disk (log line) and in
`_events`, while the domain read views (`bayar`, `stock_moves`, `records`)
stop serving them. Forensics reads `_quarantine`; humans read the views.

## api (`src/sync.ts`)

| op | symbol | meaning |
|---|---|---|
| opts | `SyncOpts.revokedDevices` | origin device id set (`Set` or array); mirrors the relay tombstone list or `'*'` rows of a `RevokeLog` via `isDeviceRevoked` |
| opts | `SyncOpts.isRevoked(ev)` | per-event predicate for tokenId/epoch mapping; receives the remote event on pull, the local event on sweep |
| check | `isDeviceRevoked(revokeLog, deviceId)` | true when the view carries a whole-device (`tokenId '*'`) row for the device |
| sweep | `purgeRevoked(log, store, opts?)` | retroactive sweep over the log: `{ scanned, quarantined }`; idempotent, log untouched |
| read | `isQuarantined(store, id)` / `listQuarantine(store)` / `ensureQuarantine(store)` | quarantine table probes; rows are `{ event_id, reason, ts, event }` (verbatim evidence JSON) |
| count | `PullResult.quarantined` | tainted pull events quarantined instead of applied (pull-time + sweep, counted once each) |

Pull checks the revoke gate after the forgery gate on three paths: fresh
events quarantine without touching the log; parked events (logged, never
stored) quarantine instead of re-driving; redelivered stored events purge
from the views on the `hasId` path. Every path advances the pull cursor, so
taint never bricks sync.

Sync auto-sweeps: `pullRemote` and `syncWithFailover` run `purgeRevoked`
whenever revoke state is present (`revokedDevices` non-empty or `isRevoked`
set), so the kernel surface needs no extra call — converging clean and then
syncing with revoke opts purges the leftovers in the same round. Pass revoke
opts only when revoke state exists; otherwise no scan runs.

## wiring (RevokeLog -> sync)

`src/revokelog.ts` is read-only here; the caller owns the closure:

```
import { RevokeLog } from './revokelog.js';
import { isDeviceRevoked } from './sync.js';
const rl = new RevokeLog(admins);
rl.merge(peer.snapshot());                       // convergent revoke state
await k.sync(relay, {
  isRevoked: (ev) => isDeviceRevoked(rl, ev.origin_device ?? ev.device_id),
});
// pre-revoke leftovers purge in the same round via the auto-sweep above;
// unit-level callers with their own log/store use purgeRevoked directly.
```

Re-issuing a capability means minting it at a higher epoch; map
tokenId/epoch inside `isRevoked` with `rl.isRevoked(token.id, token.epoch)`.

## evidence (`test/quarantine.test.ts`)

Tainted pull quarantines (`pulled 2, applied 1, quarantined 1`), views serve
only the clean event, the log file stays clean, the cursor advances to a
quiet no-op; redelivery purges via `hasId` while `_events` keeps the row so
reopen replay cannot resurrect the views; parked events quarantine instead of
re-driving; `purgeRevoked` sweeps `{ scanned 2, quarantined 1 }` then
`{ scanned 2, quarantined 0 }` with the log bytes intact; an authenticated
`RevokeLog` merge drives predicate quarantine while the sibling device
lives; a clean-converged kernel purges retroactively on the next revoked
sync (`pulled 0, applied 0, quarantined 1`).

```
bun test test/quarantine.test.ts   # 6 pass, 0 fail
```
