// Soak-runner: seeded rng drives random append/seal/sync/restart with an
// invariant check every N steps and at the end. Port of skill-3 (stable).
// MemoryRelay only (no sockets) so each seed stays far under 60s.
// Killer case: seal collision — two snapshots collide on the same ack prefix,
// the seal survives a restart, and truncate sweeps only the sealed prefix,
// never the unacked suffix.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { mulberry32 } from '../src/relay.ts';

const fast = { baseMs: 1, maxMs: 10 };
const FIXED_SEEDS = [7, 42, 20260905];
const STEPS = Number(process.env.SOAK_STEPS ?? 200);
const CHECK_EVERY = Number(process.env.SOAK_CHECK_EVERY ?? 20);
const SEEDS = process.env.SOAK_SEED ? [Number(process.env.SOAK_SEED)] : FIXED_SEEDS;

interface Model {
  live: Map<string, number>; // payment id -> amount
  expected: number; // sum of live amounts
}

interface Floor {
  ack: number; // high-water ackSeq: must never regress
  sealed: number; // high-water sealed_seq: must never regress
  checks: number; // invariant checks performed
  total: number; // events ever appended (seqs are never reused)
}

async function checkInvariants(k: Kernel, model: Model, relay: MemoryRelay, floor: Floor): Promise<void> {
  floor.checks += 1;
  // verifyLog clean.
  const v = k.verifyLog() as { ok: boolean; gaps?: number[] };
  assert.equal(v.ok, true);
  assert.deepEqual(v.gaps ?? [], []);
  const h = k.health();
  assert.equal(h.quarantined, 0);

  // Totals match the model.
  const rows = await k.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
  const sqlTotal = rows[0].total ?? 0;
  assert.equal(sqlTotal, model.expected, 'sql total diverges from model');
  const liveRows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM payment WHERE voided = 0`);
  assert.equal(liveRows[0].n, model.live.size);

  // No lost acked events: cursor never regresses and every acked seq is
  // present locally (truncate sweeps the log file, never the store — the db
  // keeps answering the full prefix). The relay holds every acked event.
  const ack = k.ackSeq();
  assert.ok(ack >= floor.ack, `ack regressed ${floor.ack} -> ${ack}`);
  floor.ack = ack;
  assert.ok(ack <= floor.total, `ack ${ack} beyond appended ${floor.total}`);
  const kept = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE seq <= $ack`, { ack });
  assert.equal(kept[0].n, ack, 'acked seqs missing from store');
  assert.ok(relay.size >= ack, `relay lost acked events: size ${relay.size} < ack ${ack}`);

  // Seal discipline: sealed_seq never covers unacked data, never regresses.
  const meta = await k.query<{ v: string }>(`SELECT v FROM _meta WHERE k = 'snapshot.sealed_seq'`);
  const sealed = meta.length ? Number(meta[0].v) : 0;
  assert.ok(sealed <= ack, `seal ${sealed} covers unacked data (ack ${ack})`);
  assert.ok(sealed >= floor.sealed, `seal regressed ${floor.sealed} -> ${sealed}`);
  floor.sealed = sealed;

  // Relay exact-once by UUID.
  const { events } = await relay.pull(0);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'relay holds duplicates');
}

async function runSoak(seed: number): Promise<{ ops: number; checks: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-soak-runner-'));
  const dbPath = join(dir, 'ledger.db');
  const relay = new MemoryRelay();
  let k: Kernel = await createKernel({ file: dbPath });
  const model: Model = { live: new Map(), expected: 0 };
  const floor: Floor = { ack: 0, sealed: 0, checks: 0, total: 0 };
  const rng = mulberry32(seed >>> 0);
  try {
    for (let step = 0; step < STEPS; step++) {
      const r = rng();
      if (r < 0.45) {
        const amount = 100 + Math.floor(rng() * 4900);
        const ev = await k.append({ type: 'payment', amount, actor: 'soak-runner' });
        model.live.set(ev.id, amount);
        model.expected += amount;
        floor.total += 1;
      } else if (r < 0.6) {
        // Seal: snapshot always, truncate on coin flip (sealed prefix only).
        await k.snapshot();
        if (rng() < 0.5) await k.truncate();
      } else if (r < 0.8) {
        const chunkSize = 1 + Math.floor(rng() * 10);
        try {
          await k.sync(relay, { chunkSize, maxRetries: 5, ...fast });
        } catch {
          /* injected relay drop: cursor must not regress (checked below) */
        } finally {
          relay.failPushes = 0;
          relay.failAfterEvents = null;
        }
        assert.ok(k.ackSeq() >= floor.ack, 'ack regressed across sync');
      } else {
        // Restart: close without cleanup and reopen on the same files.
        const ackBefore = k.ackSeq();
        k.close();
        k = await createKernel({ file: dbPath });
        assert.equal(k.ackSeq(), ackBefore, 'ack cursor must survive respawn');
      }
      if ((step + 1) % CHECK_EVERY === 0) await checkInvariants(k, model, relay, floor);
    }
    relay.failPushes = 0;
    relay.failAfterEvents = null;
    await k.sync(relay, { chunkSize: 50, maxRetries: 20, ...fast });
    await k.snapshot();
    await k.truncate();
    await checkInvariants(k, model, relay, floor);
    assert.equal(k.ackSeq(), floor.total, 'unconverged tail after final sync');
    console.log(`[soak-runner] seed=${seed} ops=${STEPS} invariant_checks=${floor.checks} ack=${floor.ack} sealed=${floor.sealed}`);
    return { ops: STEPS, checks: floor.checks };
  } finally {
    k.close();
  }
}

describe('soak-runner', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: append/seal/sync/restart hold invariants`, () => runSoak(seed), 55_000);
  }

  it('seal collision: colliding snapshots sweep only the sealed prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-soak-killer-'));
    const dbPath = join(dir, 'ledger.db');
    const relay = new MemoryRelay();
    let k = await createKernel({ file: dbPath });
    try {
      let expected = 0;
      for (let i = 0; i < 10; i++) {
        expected += 100;
        await k.append({ type: 'payment', amount: 100, actor: 'device' });
      }
      const up = await k.sync(relay, { chunkSize: 50, ...fast });
      assert.equal(up.acked, 10);
      const snap1 = await k.snapshot();
      assert.equal(snap1.sealedSeq, 10);

      // Unacked suffix lands after the first seal.
      for (let i = 0; i < 3; i++) {
        expected += 7;
        await k.append({ type: 'payment', amount: 7, actor: 'device' });
      }
      // Second seal collides with the first: ack did not move, seal must not.
      const snap2 = await k.snapshot();
      assert.equal(snap2.sealedSeq, 10);

      // Seal survives a restart; truncate must keep the unacked suffix.
      k.close();
      k = await createKernel({ file: dbPath });
      assert.equal(k.ackSeq(), 10);
      const cut = await k.truncate();
      assert.deepEqual(cut, { removed: 10, kept: 3, sealedSeq: 10 });
      assert.deepEqual(k.verifyLog(), { ok: true });
      const rows = await k.query<{ total: number; n: number }>(
        `SELECT SUM(amount) AS total, COUNT(*) AS n FROM payment WHERE voided = 0`,
      );
      assert.equal(rows[0].total, expected);
      assert.equal(rows[0].n, 13);

      // Drain the suffix, seal again, sweep the rest.
      const re = await k.sync(relay, { chunkSize: 50, ...fast });
      assert.equal(re.acked, 3);
      const snap3 = await k.snapshot();
      assert.equal(snap3.sealedSeq, 13);
      const cut2 = await k.truncate();
      assert.deepEqual(cut2, { removed: 3, kept: 0, sealedSeq: 13 });
      assert.deepEqual(k.verifyLog(), { ok: true });
      const rows2 = await k.query<{ total: number }>(`SELECT SUM(amount) AS total FROM payment WHERE voided = 0`);
      assert.equal(rows2[0].total, expected);
      console.log('[soak-runner] killer=seal-collision removed=10+3 kept=3+0 suffix_intact=true');
    } finally {
      k.close();
    }
  }, 55_000);
});
