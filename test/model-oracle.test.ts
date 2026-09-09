// model-oracle test: shared Oracle (scripts/model-oracle.ts) vs kernel over
// 1000 seeded mixed ops; state compared every 100 steps plus final converge.
// lighter deterministic sibling of test/model-fuzz.test.ts (5000 steps, inline oracle).
import { describe, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { mulberry32 } from '../src/relay.ts';
import { Oracle, checkOracle } from '../scripts/model-oracle.ts';

const STEPS = 1000;
const CHECK_EVERY = 100;
const SEED = 20260906;
const ACTOR = ['device-a', 'device-b'];
const ITEMS = ['WIDGET-01', 'WIDGET-02'];

async function runOracle(seed: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-oracle-'));
  const dbPath = join(dir, 'ledger.db');
  const relay = new MemoryRelay();
  let k: Kernel = await createKernel({ file: dbPath });
  const o = new Oracle();
  const known: string[] = [];
  const log: string[] = [];
  const rng = mulberry32(seed >>> 0);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  const q = (sql: string) => k.query(sql) as Promise<Record<string, unknown>[]>;
  try {
    for (let step = 0; step < STEPS; step++) {
      const r = rng();
      let op = '';
      if (r < 0.4 || known.length === 0) {
        const value = 100 + Math.floor(rng() * 4900);
        const actor = pick(ACTOR);
        const ev = await k.append({ type: 'entry', value, actor });
        o.entry(ev.id, value, actor);
        known.push(ev.id);
        op = `entry ${ev.id} value=${value} actor=${actor}`;
      } else if (r < 0.55) {
        const item = pick(ITEMS);
        const qty = 1 + Math.floor(rng() * 20);
        const ev = await k.append({ type: 'tally.add', item, qty });
        o.add(ev.id, item, qty);
        known.push(ev.id);
        op = `tally.add ${ev.id} item=${item} qty=${qty}`;
      } else if (r < 0.65) {
        const item = pick(ITEMS);
        const qty = 1 + Math.floor(rng() * 10);
        const ev = await k.append({ type: 'tally.remove', item, qty });
        o.remove(ev.id, item, qty);
        known.push(ev.id);
        op = `tally.remove ${ev.id} item=${item} qty=${qty}`;
      } else if (r < 0.8) {
        const target = rng() < 0.1 ? `no-such-${Math.floor(rng() * 1e9)}` : pick(known);
        await k.undo(target, 'oracle');
        o.undo(target);
        op = `undo reverses=${target}`;
      } else if (r < 0.97) {
        const chunkSize = 1 + Math.floor(rng() * 20);
        await k.sync(relay, { chunkSize, maxRetries: 5, baseMs: 1, maxMs: 10 });
        op = `sync chunk=${chunkSize} ack=${k.ackSeq()}`;
      } else {
        k.close();
        k = await createKernel({ file: dbPath });
        assert.equal(k.verifyLog().ok, true, `seed=${seed} step=${step}: log not clean after replay`);
        op = `replay events=${k.health().events}`;
      }
      log.push(`${step}: ${op}`);
      if ((step + 1) % CHECK_EVERY === 0) {
        await checkOracle(q, o, `seed=${seed} step=${step} op=${op}`, log.slice(-80).join('\n'));
      }
    }
    await k.sync(relay, { chunkSize: 50, maxRetries: 20, baseMs: 1, maxMs: 10 });
    await checkOracle(q, o, `seed=${seed} step=${STEPS} op=final`, log.slice(-80).join('\n'));
    assert.equal(k.ackSeq(), k.health().events, `seed=${seed}: unconverged tail`);
  } finally {
    k.close();
  }
}

describe('model-oracle', () => {
  it(`seed ${SEED}: shared oracle matches kernel over ${STEPS} mixed ops`, () => runOracle(SEED), 120_000);
});
