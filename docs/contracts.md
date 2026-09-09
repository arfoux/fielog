# contracts

Behavioral promises that must never be broken. Each item points at code —
not intent.

## 1. dead-letter: one poison event never pins the cursor

- Push: partial ack halts, the cursor advances only up to what was acked;
  the next run resumes from there (`applyPushAck`, `src/sync.ts:134-184`).
- Pull: poison (invalid shape) / forged (bad signature) / revoked events
  are quarantined into `_quarantine` as evidence, the cursor still advances
  (`applyPullEvents`, `src/sync.ts:395-503`; forgery gate
  `verifyPullAuth`, `src/sync.ts:195-225`).
- Deltasync: shape-invalid UUIDs are recorded in meta `<cursorKey>.dead`
  and never re-fetched; the want-list still drains (`src/deltasync.ts:10-13`).

## 2. blind compensators: undo/settle need no local target

`kernel.undo` / `settle` append compensation events without checking the
target exists (`src/kernel.ts:210-218`). Convergence via fold, not local
presence: compensation arriving before its target parks in
`records`/`conflicts` and revives when the target lands
(`resolvePendingUndos`, `src/store.ts:233-267`).
Pinned by `scripts/model-oracle.ts` + `docs/model-oracle.md`.

## 3. seal <= ack: truncate must never eat unsafe data

The snapshot seal is clamped to the prefix that is stored AND acked before
sweeping (`clampSealToStored`, `src/retain.ts:123-147`; used by the kernel at
`src/kernel.ts:248-254`). A stale seal = no-op. Above that, `guardSeal`
(`src/tombstone.ts:190-232`) holds legal-hold events and refuses to split
hide/target pairs (clamp below BOTH seqs, fixpoint).

## 4. device.explicit: reject split-brain, first explicit adoption allowed

Meta `device.id` + `device.explicit` (`src/kernel.ts:108-126`): opening with
an explicit `deviceId` that differs from the stored explicit id → throws
`ERR_DEVICE_MISMATCH`. The init-then-sync flow (file born without an id,
then opened with the first explicit id) is adopted and marked explicit —
exactly once.

## 5. incremental purge: revoke sweep O(new), not O(log)

`purgeRevoked` (`src/sync.ts:359-386`) tracks the `sync.purge_seq` cursor +
revoke-signal fingerprint (`sync.purge_revoke_fp`). Same revoke state =
only new log lines are scanned; new revocation = full rescan.
An `isRevoked` predicate without `revokeVersion` always rescans (opaque closure).

## 6. deterministic jitter by default, random is opt-in

`backoffMs` (`src/sync.ts:74-88`): default jitter = `((attempt+1)*37) % 100`
— the same retry sleeps the same millis on every run (tests pin exact
timing). `SyncOpts.jitter`: `true` = random via `Math.random()`, number =
fixed jitter, function = custom `[0,1)` source.

## 7. writer superset compat (v0.5)

Writer output = v0.5 fields + known optionals (`actor, origin_seq,
origin_device, server_time`); new fields must be optional + unhashed +
never renamed/repurposed (`docs/compat.md`, `canonicalOf` in `src/log.ts`
= frozen list). Fixture: `test/fixtures/v05-ledger.log`, pinned by
`test/compat-v05.test.ts`.
