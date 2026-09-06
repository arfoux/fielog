// compat vectors (SEHAT): cross-version read-write conformance over the
// frozen v0.5 fixtures in test/fixtures/v0.5/. New kernel reads old logs
// (baca); old readers still verify new tails after stripping known-optional
// fields (tulis silang). See docs/compat-vectors.md.
import { describe, it, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { hashFor } from '../src/log.ts';

const here = dirname(fileURLToPath(import.meta.url));

const V05_FIELDS = new Set([
  'id', 'seq', 'type', 'device_id', 'ts_device', 'payload', 'prev_hash', 'hash',
]);
const KNOWN_OPTIONAL = new Set(['actor', 'origin_seq', 'origin_device', 'server_time']);
// Unhashed-or-null-tolerant envelope an old (v0.5) reader drops before checking.
const STRIP = ['server_time', 'origin_seq', 'origin_device', 'signature', 'countersignatures'];

interface Fixture {
  file: string;
  events: number;
  bayarN: number;
  bayarTotal: number;
  stockItem: string;
  stockQty: number;
}

const FIXTURES: Fixture[] = [
  { file: 'kasir-minimal.log', events: 5, bayarN: 2, bayarTotal: 40000, stockItem: 'kopi', stockQty: 97 },
  { file: 'kasir-actor.log', events: 4, bayarN: 2, bayarTotal: 15000, stockItem: 'gula', stockQty: 47 },
];

const rawLines = (f: Fixture): string[] =>
  readFileSync(join(here, 'fixtures', 'v0.5', f.file), 'utf8').trim().split('\n');
describe('compat vectors SEHAT', () => {
  const kernels = new Map<string, Kernel>();
  beforeAll(async () => {
    for (const f of FIXTURES) {
      const dir = mkdtempSync(join(tmpdir(), 'fielog-sehat-'));
      copyFileSync(join(here, 'fixtures', 'v0.5', f.file), join(dir, 'kasir.log'));
      kernels.set(f.file, await createKernel({ file: join(dir, 'kasir.db') }));
    }
  });
  afterAll(() => {
    for (const k of kernels.values()) k.close();
  });

  it('S: fixture seqs contiguous from 1 with GENESIS-anchored prev_hash chain', () => {
    for (const f of FIXTURES) {
      const lines = rawLines(f);
      assert.equal(lines.length, f.events);
      let prev = 'GENESIS';
      lines.forEach((line, i) => {
        const ev = JSON.parse(line);
        assert.equal(ev.seq, i + 1);
        assert.equal(ev.prev_hash, prev);
        prev = ev.hash;
      });
    }
  });

  it('E: fixture lines carry v0.5 fields plus known-optional only', () => {
    for (const f of FIXTURES) {
      for (const line of rawLines(f)) {
        const ev = JSON.parse(line) as Record<string, unknown>;
        for (const key of Object.keys(ev)) {
          assert.ok(V05_FIELDS.has(key) || KNOWN_OPTIONAL.has(key), `${f.file} has unexpected field ${key}`);
        }
        for (const key of V05_FIELDS) assert.ok(key in ev, `${f.file} missing ${key}`);
      }
    }
  });

  it('H: fixture chain hash-verifies and strip-verifies like an old reader', () => {
    for (const f of FIXTURES) {
      for (const line of rawLines(f)) {
        const ev = JSON.parse(line);
        const { hash, ...core } = ev;
        assert.equal(hashFor(core), hash);
        const stripped: Record<string, unknown> = { ...core };
        for (const key of STRIP) delete stripped[key];
        assert.equal(hashFor(stripped as Parameters<typeof hashFor>[0]), hash);
      }
      assert.deepEqual(kernels.get(f.file)!.verifyLog(), { ok: true });
    }
  });

  it('T: old log replays into the read-model with pinned totals', async () => {
    for (const f of FIXTURES) {
      const k = kernels.get(f.file)!;
      assert.equal(k.health().events, f.events);
      const bayar = await k.query<{ n: number; total: number }>(
        `SELECT COUNT(*) AS n, SUM(nominal) AS total FROM bayar WHERE voided = 0`,
      );
      assert.equal(bayar[0].n, f.bayarN);
      assert.equal(bayar[0].total, f.bayarTotal);
      const stock = await k.query<{ qty: number }>(`SELECT qty FROM stock WHERE item = ?`, [f.stockItem]);
      assert.equal(stock[0].qty, f.stockQty);
    }
  });

  it('A: append continues the old tip and the new tail stays old-readable', async () => {
    for (const f of FIXTURES) {
      const k = kernels.get(f.file)!;
      const tip = JSON.parse(rawLines(f).at(-1)!).hash;
      const ev = await k.append({ type: 'bayar', nominal: 1000, oleh: 'sehat' });
      assert.equal(ev.seq, f.events + 1);
      assert.equal(ev.prev_hash, tip);
      assert.deepEqual(k.verifyLog(), { ok: true });
      for (const line of readFileSync(k.logPath, 'utf8').trim().split('\n')) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) {
          assert.ok(V05_FIELDS.has(key) || KNOWN_OPTIONAL.has(key), `writer emitted unknown field ${key}`);
        }
        for (const key of V05_FIELDS) assert.ok(key in parsed, `writer dropped v05 field ${key}`);
        const { hash, ...core } = parsed;
        const stripped: Record<string, unknown> = { ...core };
        for (const key of STRIP) delete stripped[key];
        assert.equal(hashFor(stripped as Parameters<typeof hashFor>[0]), hash);
      }
    }
  });
});
