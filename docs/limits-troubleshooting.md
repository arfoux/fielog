# limits-troubleshooting

Honest limits + ways out of common problems. No false promises.

## Design limits

- Bun only. `bun:sqlite` + `Bun.serve` do not exist in Node (`docs/install.md`).
- Single writer, one process per file — no exceptions. Two writers in
  different processes on one `ledger.log` / `ledger.db` race
  last-write-wins on both files; two `createKernel` handles in one
  process share nothing (the append/truncate mutex is a cooperative
  promise chain, `src/kernel.ts:145-156`). One kernel per file,
  `close()` before reopen. Same for [cas-store](cas-store.md) manifests.
- Bounded outbox: default 50_000 unsynced events, past that `append`
  throws `ERR_OUTBOX_FULL` (`maxPending`, `src/kernel.ts`). Sync to
  drain, or knowingly raise (`maxPending`) for giant bench builds.
- Unsigned relay = anyone may claim any device. Production requires
  `--trust` + token (see [auth](auth.md)).
- Self-signed capability tokens: leaked = usable by whoever holds them until
  expiry/revocation. Keep them short + rotate.
- Hidden is not encryption: raw-SQL `kernel.query` still sees hidden rows;
  holds never sync to peers (see
  [tombstone-engine](tombstone-engine.md)).
- `quota.ts` is standalone: no kernel wiring; callers reserve manually
  (see [quota-guard](quota-guard.md)).
- `deltasync.ts` has no signature verification: only for trusted same-operator
  replicas (see [sync-protocol](sync-protocol.md)).
- The 100k bench query needs a ~259 s one-time build; latencies in
  [bench](bench.md) are post-build steady-state.

## Troubleshooting

| symptom | likely cause | fix |
|---|---|---|
| `ERR_DEVICE_MISMATCH` on open | explicit `deviceId` differs from the stored explicit id | open with the stored id, or a new file for a new device |
| `ERR_OUTBOX_FULL` | outbox ≥ cap | `sync`, then append again |
| `entry rejected: value ...` | value is not a positive integer | fix the input; no log line is written (fail-fast) |
| `entry rejected: state ...` | state other than `DRAFT`/`RECORDED` | resolution only via `resolve`/online ack |
| `ERR_UNKNOWN_TARGET` (hide/hold) | mistyped id / target not yet synced | check the id; blind compensators (`undo`/`resolve`) need no local target |
| `ERR_NOT_HIDDEN` (show) | the id is genuinely not hidden | nothing is written; check `hiddenIds` |
| `serve needs --trust ...` (exit 2) | serve without a registry | add `--trust id=pub.pem` or `--unsigned` (dev) |
| `relay rejected push/pull` | wrong token scope / revoked / unknown device | check token scope, expiry, the `--trust` registry, revocation status |
| sync stuck on one event | poison/forgery — quarantined by design, cursor advances | check `_quarantine` via `listQuarantine`; the evidence data stays |
| `health().repairedTail = true` | kill mid-append; the torn tail is trimmed on open | normal; intact data = up to the last valid seq |
| `health().gaps` non-empty | seqs re-anchored after quarantine lines | known gaps, not tampering (see [quarantine](quarantine.md)) |
| port already in use | the old relay is still alive | `kill` the old process / another `--port`; double `start()` throws `relay already started` |
| `ERR_QUOTA_EXCEEDED` | files exceed the guard ceiling | release reservations / raise the ceiling |
| `ERR_QUOTA_UNKNOWN` | path cannot be stat'ed | fix permissions/path; the guard is fail-closed |

## Getting help

Include: version (`package.json`), the exact command, the exact error
message, `health()` + `verifyLog()` for log issues. Report per
[SECURITY](../SECURITY.md) for security issues.
