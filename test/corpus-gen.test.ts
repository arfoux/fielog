// corpus-gen test: determinism (same seed = byte-identical corpus) +
// replay (corpus replays through the kernel with verifyLog clean and the
// read-model matching the shared Oracle). Port of skill-10 (SEHAT).
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { Oracle, checkOracle } from '../scripts/model-oracle.ts';
import { corpusManifest, corpusSha, genCorpus } from '../scripts/corpus-gen.ts';

describe('corpus-gen determinism', () => {
  it('same seed yields byte-identical corpus', () => {
    const a = genCorpus(42, 200);
    const b = genCorpus(42, 200);
    assert.equal(corpusSha(a), corpusSha(b));
    assert.deepEqual(a, b);
    console.log(`[corpus-gen] determinism seed=42 n=200 sha=${corpusSha(a).slice(0, 12)}`);
  });

  it('different seeds diverge', () => {
    const a = genCorpus(42, 200);
    const b = genCorpus(43, 200);
    assert.notEqual(corpusSha(a), corpusSha(b));
  });

  it('seed is normalized to uint32', () => {
    assert.equal(corpusSha(genCorpus(42, 50)), corpusSha(genCorpus(42 >>> 0, 50)));
  });
});

describe('corpus-gen replay', () => {
  it('replays through the kernel matching the oracle, verifyLog clean', async () => {
    const c = genCorpus(42, 200);
    const m = corpusManifest(c);
    assert.equal(m.n, 200);
    assert.equal(m.counts.bayar + m.counts.add + m.counts.sell + m.counts.undo, 200);
    const dir = mkdtempSync(join(tmpdir(), 'fielog-corpus-gen-'));
    const k = await createKernel({ file: join(dir, 'kasir.db') });
    try {
      const o = new Oracle();
      const q = (sql: string) => k.query(sql) as Promise<Record<string, unknown>[]>;
      // kernel mints its own UUIDs (toAppendInput strips caller ids), so map
      // corpus id -> kernel id and drive the oracle with kernel ids; undo
      // targets resolve through the same map, keeping both books aligned.
      const idMap = new Map<string, string>();
      for (const e of c.events) {
        if (e.type === 'bayar') {
          const ev = await k.append({ type: 'bayar', nominal: e.payload['nominal'], oleh: e.payload['oleh'] });
          idMap.set(e.id, ev.id);
          o.bayar(ev.id, Number(e.payload['nominal']), String(e.payload['oleh']));
        } else if (e.type === 'stock.add') {
          const ev = await k.append({ type: 'stock.add', payload: { item: e.payload['item'], qty: e.payload['qty'] } });
          idMap.set(e.id, ev.id);
          o.add(ev.id, String(e.payload['item']), Number(e.payload['qty']));
        } else if (e.type === 'stock.sell') {
          const ev = await k.append({ type: 'stock.sell', payload: { item: e.payload['item'], qty: e.payload['qty'] } });
          idMap.set(e.id, ev.id);
          o.sell(ev.id, String(e.payload['item']), Number(e.payload['qty']));
        } else {
          const target = idMap.get(String(e.payload['reverses'])) ?? String(e.payload['reverses']);
          const ev = await k.append({ type: 'undo.compensate', payload: { reverses: target } });
          idMap.set(e.id, ev.id);
          o.undo(target);
        }
      }
      await checkOracle(q, o, 'corpus-gen seed=42', `sha=${m.sha.slice(0, 12)} n=200`);
      assert.deepEqual(k.verifyLog(), { ok: true });
      console.log(
        `[corpus-gen] replay seed=42 n=200 sha=${m.sha.slice(0, 12)} ` +
          `bayar=${m.counts.bayar} add=${m.counts.add} sell=${m.counts.sell} undo=${m.counts.undo} verify=ok`,
      );
    } finally {
      k.close();
    }
  }, 55_000);
});
