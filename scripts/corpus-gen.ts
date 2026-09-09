// corpus-gen: deterministic synthetic corpus for fielog spins.
// Port of skill-10 (corpus-generator, status HEALTHY): seeded mulberry32 emits
// a fixed op mix (entry / stock.add / stock.sell / undo.compensate) with
// deterministic ids, so the same (seed, n) always yields byte-identical JSONL.
// Library (genCorpus/corpusSha/writeCorpus) + CLI (bun scripts/corpus-gen.ts).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '../src/relay.ts';

export interface CorpusEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  actor: string;
}

export interface Corpus {
  seed: number;
  n: number;
  events: CorpusEvent[];
}

export interface CorpusManifest {
  seed: number;
  n: number;
  sha: string;
  counts: { entry: number; add: number; sell: number; undo: number };
}

const ACTORS = ['device-a', 'device-b', 'device-c'];
const ITEMS = ['kopi', 'gula', 'beras'];

/** Pure + deterministic: same (seed, n) -> identical events, no IO, no clock. */
export function genCorpus(seed: number, n: number): Corpus {
  const rng = mulberry32(seed >>> 0);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  const events: CorpusEvent[] = [];
  const known: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `corpus-${seed >>> 0}-${i}`;
    const r = rng();
    if (r < 0.5 || known.length === 0) {
      const value = 100 + Math.floor(rng() * 4900);
      const actor = pick(ACTORS);
      events.push({ id, type: 'entry', payload: { value, actor }, actor });
      known.push(id);
    } else if (r < 0.7) {
      const item = pick(ITEMS);
      const qty = 1 + Math.floor(rng() * 20);
      events.push({ id, type: 'stock.add', payload: { item, qty }, actor: 'gudang' });
      known.push(id);
    } else if (r < 0.85) {
      const item = pick(ITEMS);
      const qty = 1 + Math.floor(rng() * 10);
      events.push({ id, type: 'stock.sell', payload: { item, qty }, actor: 'device-a' });
      known.push(id);
    } else {
      const reverses = known[Math.floor(rng() * known.length)];
      events.push({ id, type: 'undo.compensate', payload: { reverses }, actor: 'device-a' });
      known.push(id);
    }
  }
  return { seed: seed >>> 0, n, events };
}

/** Canonical bytes: fixed key order, one JSON object per line. */
export function corpusLines(c: Corpus): string[] {
  return c.events.map((e) =>
    JSON.stringify({ id: e.id, type: e.type, payload: e.payload, actor: e.actor }),
  );
}

export function corpusSha(c: Corpus): string {
  return createHash('sha256').update(corpusLines(c).join('\n')).digest('hex');
}

export function corpusManifest(c: Corpus): CorpusManifest {
  const counts = { entry: 0, add: 0, sell: 0, undo: 0 };
  for (const e of c.events) {
    if (e.type === 'entry') counts.entry += 1;
    else if (e.type === 'stock.add') counts.add += 1;
    else if (e.type === 'stock.sell') counts.sell += 1;
    else counts.undo += 1;
  }
  return { seed: c.seed, n: c.n, sha: corpusSha(c), counts };
}

export function writeCorpus(c: Corpus, outDir: string): { jsonl: string; manifest: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonl = join(outDir, `corpus-${c.seed}-${c.n}.jsonl`);
  const manifest = join(outDir, `corpus-${c.seed}-${c.n}.manifest.json`);
  writeFileSync(jsonl, corpusLines(c).join('\n') + '\n');
  writeFileSync(manifest, JSON.stringify(corpusManifest(c), null, 2) + '\n');
  return { jsonl, manifest };
}

function usage(): string {
  return 'usage: bun scripts/corpus-gen.ts [--seed N] [--n N] [--out DIR]';
}

// CLI only when run directly, never on import (test imports the library).
const direct = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/corpus-gen.ts');
if (direct) {
  let seed = Number(process.env.CORPUS_SEED ?? 42);
  let n = Number(process.env.CORPUS_N ?? 200);
  let out = 'corpus';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--seed' && i + 1 < args.length) seed = Number(args[++i]);
    else if (a === '--n' && i + 1 < args.length) n = Number(args[++i]);
    else if (a === '--out' && i + 1 < args.length) out = args[++i];
    else if (a === '-h' || a === '--help') {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`error: unknown flag '${a}'`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (!Number.isInteger(seed) || seed < 0 || !Number.isInteger(n) || n <= 0) {
    console.error('error: --seed must be a non-negative integer, --n a positive integer');
    process.exit(2);
  }
  const c = genCorpus(seed, n);
  const m = corpusManifest(c);
  const paths = writeCorpus(c, out);
  console.log(
    `[corpus-gen] seed=${m.seed} n=${m.n} sha=${m.sha.slice(0, 12)} ` +
      `entry=${m.counts.entry} add=${m.counts.add} sell=${m.counts.sell} undo=${m.counts.undo}`,
  );
  console.log(`[corpus-gen] wrote ${paths.jsonl} + ${paths.manifest}`);
}
