// Soak: seeded rng drives random interleavings of append/undo/sync/
// kill-respawn/relay-drop; invariants checked every N steps and at the end:
// totals match the log minus voided, verifyLog clean, no lost acked events.
// Fixed seeds for determinism plus one unseeded run. MemoryRelay only
// (no sockets) so each run stays far under 60s.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { mulberry32 } from '../src/relay.ts';

const fast = { baseMs: 1, maxMs: 10 };
const FIXED_SEEDS = [7, 42, 20260905];
const STEPS = 250;
const CHECK_EVERY = 25;

interface Model {
  live: Map<string, number>; // bayar id -> nominal, not yet undone
  expected: number; // sum of live nominals
}

interface Floor {
  ack: number; // high-water ackSeq: must never regress (no lost acked events)
}

// Sum of bayar nominals minus voided, derived straight from the log file.
function fileTotal(logPath: string): { total: number; live: number } {
  const nominalById = new Map<string, number>();
  const voided = new Set<string>();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const ev = JSON.parse(t) as { id: string; type: string; payload: Record<string, unknown> };
    if (ev.type === 'bayar') nominalById.set(ev.id, Number(ev.payload.nominal));
    else if (ev.type === 'undo.compensate') voided.add(String(ev.payload.reverses));
  }
  let total = 0;
  let live = 0;
  for (const [id, nominal] of nominalById) {
    if (voided.has(id)) continue;
    total += nominal;
    live += 1;
  }
  return { total, live };
}

async function checkInvariants(k: Kernel, model: Model, relay: MemoryRelay, floor: Floor): Promise<void> {
  // verifyLog clean.
  const v = k.verifyLog() as { ok: boolean; gaps?: number[] };
  assert.equal(v.ok, true);
  assert.deepEqual(v.gaps ?? [], []);
  const h = k.health();
  assert.equal(h.quarantined, 0);

  // Totals match the log minus voided: model and file agree with the read-model.
  const rows = await k.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
  const sqlTotal = rows[0].total ?? 0;
  assert.equal(sqlTotal, model.expected, 'sql total diverges from model');
  const file = fileTotal(k.logPath);
  assert.equal(sqlTotal, file.total, 'sql total diverges from log file');
  assert.equal(file.live, model.live.size, 'live count diverges from log file');
  const liveRows = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM bayar WHERE voided = 0`);
  assert.equal(liveRows[0].n, model.live.size);

  // No lost acked events: cursor never regresses, every acked seq is present
  // locally, and the relay holds every acked event.
  const ack = k.ackSeq();
  assert.ok(ack >= floor.ack, `ack regressed ${floor.ack} -> ${ack}`);
  floor.ack = ack;
  assert.ok(ack <= h.events, `ack ${ack} beyond log ${h.events}`);
  const kept = await k.query<{ n: number }>(`SELECT COUNT(*) AS n FROM _events WHERE seq <= $ack`, { ack });
  assert.equal(kept[0].n, ack, 'acked seqs missing from store');
  assert.ok(relay.size >= ack, `relay lost acked events: size ${relay.size} < ack ${ack}`);

  // Relay exact-once by UUID.
  const { events } = await relay.pull(0);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'relay holds duplicates');
}

async function runSoak(seed: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-soak-'));
  const dbPath = join(dir, 'kasir.db');
  const relay = new MemoryRelay();
  let k: Kernel = await createKernel({ file: dbPath });
  const model: Model = { live: new Map(), expected: 0 };
  const floor: Floor = { ack: 0 };
  const rng = mulberry32(seed >>> 0);
  try {
    for (let step = 0; step < STEPS; step++) {
      const r = rng();
      if (r < 0.5 || model.live.size === 0) {
        // Append. Undo falls through to here when nothing is live.
        const nominal = 100 + Math.floor(rng() * 4900);
        const ev = await k.append({ type: 'bayar', nominal, oleh: 'soak' });
        model.live.set(ev.id, nominal);
        model.expected += nominal;
      } else if (r < 0.62) {
        // Undo a random live payment.
        const ids = [...model.live.keys()];
        const id = ids[Math.floor(rng() * ids.length)];
        await k.undo(id, 'soak');
        model.expected -= model.live.get(id) as number;
        model.live.delete(id);
      } else if (r < 0.82) {
        // Sync through drops; rejection is fine, regression is not.
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
      } else if (r < 0.9) {
        // Relay-drop: arm a transient outage or mid-batch cut for the next sync.
        if (rng() < 0.5) relay.failPushes = 1 + Math.floor(rng() * 3);
        else relay.failAfterEvents = Math.floor(rng() * 8);
      } else {
        // Kill-child-respawn: close without cleanup and reopen on the same
        // files. Appends fsync per line so close+reopen is the crash-recovery
        // path (replay is idempotent by UUID); real SIGKILL is in kill9.test.ts.
        const ackBefore = k.ackSeq();
        k.close();
        k = await createKernel({ file: dbPath });
        assert.equal(k.ackSeq(), ackBefore, 'ack cursor must survive respawn');
      }
      if ((step + 1) % CHECK_EVERY === 0) await checkInvariants(k, model, relay, floor);
    }
    // Converge on a healthy relay, then check everything one last time.
    relay.failPushes = 0;
    relay.failAfterEvents = null;
    await k.sync(relay, { chunkSize: 50, maxRetries: 20, ...fast });
    await checkInvariants(k, model, relay, floor);
    assert.equal(k.ackSeq(), k.health().events, 'unconverged tail after final sync');
    assert.equal(relay.size, k.health().events, 'relay missing events after final sync');
  } finally {
    k.close();
  }
}

describe('soak', () => {
  for (const seed of FIXED_SEEDS) {
    it(`seed ${seed}: random interleavings hold invariants`, () => runSoak(seed), 55_000);
  }
  it('unseeded: random interleavings hold invariants', () => {
    const seed = (Date.now() ^ ((Math.random() * 2 ** 31) >>> 0)) >>> 0;
    console.log(`[soak] unseeded run seed=${seed}`);
    return runSoak(seed);
  }, 55_000);
});
