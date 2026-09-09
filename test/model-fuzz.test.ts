// model-fuzz: in-memory oracle vs kernel over 5000 seeded mixed ops.
// ops (applied identically to both): append entry, tally.add/remove, undo,
// kill-respawn, sync, replay. state compared every 100 steps: per-actor live
// sums + tally qty per item + full voided id set vs SELECT SUM/voided.
// mismatch fails loudly with seed + step + op log. MemoryRelay only.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { mulberry32 } from '../src/relay.ts';

// oracle: plain-arithmetic mirror of store.ts routing (entry/tally/undo only).
class Oracle {
  pay = new Map<string, number>(); // actor -> live value sum
  nom = new Map<string, number>(); // entry id -> value
  who = new Map<string, string>(); // entry id -> actor
  stk = new Map<string, number>(); // item -> qty on hand
  mov = new Map<string, { i: string; q: number }>(); // live tally move -> signed qty
  void = new Set<string>(); // voided entry + tally ids (underflow parks included)
  pend = new Set<string>(); // undo targets not yet seen (records-parked)
  entry(id: string, n: number, o: string): void {
    this.nom.set(id, n); this.who.set(id, o);
    if (this.pend.has(id)) { this.void.add(id); this.pend.delete(id); return; }
    this.pay.set(o, (this.pay.get(o) ?? 0) + n);
  }
  add(id: string, item: string, q: number): void {
    if (this.pend.has(id)) { this.pend.delete(id); this.void.add(id); return; }
    this.stk.set(item, (this.stk.get(item) ?? 0) + q);
    this.mov.set(id, { i: item, q });
  }
  remove(id: string, item: string, q: number): void {
    if ((this.stk.get(item) ?? 0) < q) { this.void.add(id); return; } // underflow park
    if (this.pend.has(id)) { this.pend.delete(id); this.void.add(id); return; }
    this.stk.set(item, (this.stk.get(item) ?? 0) - q);
    this.mov.set(id, { i: item, q: -q });
  }
  undo(t: string): void {
    if (this.nom.has(t) && !this.void.has(t)) {
      const o = this.who.get(t) as string;
      this.pay.set(o, (this.pay.get(o) ?? 0) - (this.nom.get(t) as number));
      this.void.add(t); return;
    }
    const m = this.mov.get(t);
    if (m) { this.stk.set(m.i, (this.stk.get(m.i) ?? 0) - m.q); this.mov.delete(t); this.void.add(t); return; }
    if (!this.nom.has(t) && !this.void.has(t)) this.pend.add(t); // unknown -> park
  }
}

const STEPS = 5000;
const CHECK_EVERY = 100;
const ACTOR = ['device-a', 'device-b', 'device-c'];
const ITEMS = ['WIDGET-01', 'WIDGET-02', 'WIDGET-03'];

function norm(m: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of m) if (v !== 0) out.set(k, v);
  return out;
}

async function check(seed: number, step: number, op: string, k: Kernel, o: Oracle, log: string[]): Promise<void> {
  const ctx = `seed=${seed} step=${step} op=${op}`;
  const payRows = await k.query<{ actor: string; t: number }>(
    `SELECT actor, SUM(value) AS t FROM entries WHERE voided = 0 GROUP BY actor`);
  const pay = new Map(payRows.map((r) => [String(r.actor), Number(r.t)] as [string, number]));
  const tallyRows = await k.query<{ item: string; qty: number }>(`SELECT item, qty FROM tally`);
  const stk = new Map(tallyRows.map((r) => [String(r.item), Number(r.qty)] as [string, number]));
  const voidRows = await k.query<{ event_id: string }>(
    `SELECT event_id FROM entries WHERE voided = 1 UNION ALL SELECT event_id FROM tally_moves WHERE voided = 1`);
  const tail = log.slice(-80).join('\n');
  const loud = (what: string, exp: unknown, got: unknown) =>
    `${ctx} MISMATCH ${what}\nexpected=${JSON.stringify(exp)}\nactual=${JSON.stringify(got)}\n--- last ops ---\n${tail}`;
  assert.deepEqual(norm(pay), norm(o.pay), loud('per-actor balances', [...norm(o.pay)], [...norm(pay)]));
  assert.deepEqual(norm(stk), norm(o.stk), loud('tally balances', [...norm(o.stk)], [...norm(stk)]));
  assert.deepEqual(new Set(voidRows.map((r) => String(r.event_id))), o.void,
    loud('voided ids', [...o.void].sort(), voidRows.map((r) => String(r.event_id)).sort()));
}

async function runFuzz(seed: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-modelfuzz-'));
  const dbPath = join(dir, 'ledger.db');
  const relay = new MemoryRelay();
  let k: Kernel = await createKernel({ file: dbPath });
  const o = new Oracle();
  const known: string[] = [];
  const log: string[] = [];
  const rng = mulberry32(seed >>> 0);
  let ackFloor = 0;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
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
      } else if (r < 0.52) {
        const item = pick(ITEMS);
        const qty = 1 + Math.floor(rng() * 20);
        const ev = await k.append({ type: 'tally.add', item, qty });
        o.add(ev.id, item, qty);
        known.push(ev.id);
        op = `tally.add ${ev.id} item=${item} qty=${qty}`;
      } else if (r < 0.62) {
        const item = pick(ITEMS);
        const qty = 1 + Math.floor(rng() * 10);
        const ev = await k.append({ type: 'tally.remove', item, qty });
        o.remove(ev.id, item, qty);
        known.push(ev.id);
        op = `tally.remove ${ev.id} item=${item} qty=${qty}`;
      } else if (r < 0.74) {
        const target = rng() < 0.1 ? `no-such-${Math.floor(rng() * 1e9)}` : pick(known);
        await k.undo(target, 'fuzz');
        o.undo(target);
        op = `undo reverses=${target}`;
      } else if (r < 0.88) {
        const chunkSize = 1 + Math.floor(rng() * 20);
        await k.sync(relay, { chunkSize, maxRetries: 5, baseMs: 1, maxMs: 10 });
        assert.ok(k.ackSeq() >= ackFloor, `seed=${seed} step=${step}: ack regressed`);
        ackFloor = k.ackSeq();
        op = `sync chunk=${chunkSize} ack=${ackFloor}`;
      } else if (r < 0.895) {
        const before = k.ackSeq();
        k.close();
        k = await createKernel({ file: dbPath });
        assert.equal(k.ackSeq(), before, `seed=${seed} step=${step}: ack lost on respawn`);
        op = `kill-respawn ack=${before}`;
      } else if (r < 0.91) {
        k.close();
        k = await createKernel({ file: dbPath });
        assert.equal(k.verifyLog().ok, true, `seed=${seed} step=${step}: log not clean after replay`);
        op = `replay events=${k.health().events}`;
      } else {
        const chunkSize = 1 + Math.floor(rng() * 20);
        await k.sync(relay, { chunkSize, maxRetries: 5, baseMs: 1, maxMs: 10 });
        ackFloor = k.ackSeq();
        op = `sync chunk=${chunkSize} ack=${ackFloor}`;
      }
      log.push(`${step}: ${op}`);
      if ((step + 1) % CHECK_EVERY === 0) await check(seed, step, op, k, o, log);
    }
    await k.sync(relay, { chunkSize: 50, maxRetries: 20, baseMs: 1, maxMs: 10 });
    log.push(`final: sync ack=${k.ackSeq()}`);
    await check(seed, STEPS, 'final', k, o, log);
    assert.equal(k.ackSeq(), k.health().events, `seed=${seed}: unconverged tail`);
  } catch (err) {
    const tail = log.slice(-80).join('\n');
    throw new Error(`model-fuzz seed=${seed} failed: ${(err as Error).message}\n--- op log (last 80) ---\n${tail}`, { cause: err });
  } finally {
    k.close();
  }
}

describe('model-fuzz', () => {
  it('seed 20260906: oracle matches kernel over 5000 mixed ops', () => runFuzz(20260906), 120_000);
  it('unseeded: oracle matches kernel over 5000 mixed ops', () => {
    const seed = (Date.now() ^ ((Math.random() * 2 ** 31) >>> 0)) >>> 0;
    console.log(`[model-fuzz] unseeded run seed=${seed}`);
    return runFuzz(seed);
  }, 120_000);
});
