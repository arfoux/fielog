// v0.5-era compat: a hand-written minimal ledger.log (no actor, no
// origin_*, no server_time) must open + replay + query on the current
// kernel, and current writer output must stay in the superset rule
// (v0.5 fields + known-optional only). See docs/compat.md.
import { describe, it, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { hashFor } from '../src/log.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'v05-ledger.log');

// Minimal v0.5 field set. Anything beyond this on writer output must be
// in KNOWN_OPTIONAL (docs/compat.md).
const V05_FIELDS = new Set([
  'id', 'seq', 'type', 'device_id', 'ts_device', 'payload', 'prev_hash', 'hash',
]);
const KNOWN_OPTIONAL = new Set(['actor', 'origin_seq', 'origin_device', 'server_time']);

describe('compat v05 log', () => {
  let dir: string;
  let k: Kernel;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fielog-v05-'));
    copyFileSync(FIXTURE, join(dir, 'ledger.log'));
    k = await createKernel({ file: join(dir, 'ledger.db') });
  });
  afterAll(() => k?.close());

  it('fixture carries minimal fields only', () => {
    const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    for (const line of lines) {
      const ev = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(ev)) assert.ok(V05_FIELDS.has(key), `v05 fixture has unexpected field ${key}`);
      for (const key of V05_FIELDS) assert.ok(key in ev, `v05 fixture missing ${key}`);
    }
  });

  it('current kernel opens + verifies + replays the v05 log', async () => {
    assert.deepEqual(k.verifyLog(), { ok: true });
    assert.equal(k.health().events, 5);
    const entry = await k.query<{ n: number; total: number }>(
      `SELECT COUNT(*) AS n, SUM(value) AS total FROM entries WHERE voided = 0`,
    );
    assert.equal(entry[0].n, 2);
    assert.equal(entry[0].total, 40000);
    const tally = await k.query<{ qty: number }>(`SELECT qty FROM tally WHERE item = 'kopi'`);
    assert.equal(tally[0].qty, 97);
  });

  it('append continues the v05 chain (seq + prev_hash)', async () => {
    const tip = JSON.parse(readFileSync(FIXTURE, 'utf8').trim().split('\n').at(-1)!).hash;
    const ev = await k.append({ type: 'entry', value: 5000, actor: 'agus' });
    assert.equal(ev.seq, 6);
    assert.equal(ev.prev_hash, tip);
    assert.deepEqual(k.verifyLog(), { ok: true });
    const rows = await k.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(rows[0].total, 45000);
  });

  it('current writer output obeys the superset rule', async () => {
    const lines = readFileSync(k.logPath, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 6);
    for (const line of lines.slice(0, 5)) {
      // Old bytes unchanged: still minimal, still verifiable by an old reader
      // that only knows the v0.5 fields + null-tolerant actor.
      const ev = JSON.parse(line);
      const { hash, ...core } = ev;
      assert.equal(hashFor(core), hash);
    }
    for (const line of lines) {
      const ev = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(ev)) {
        assert.ok(V05_FIELDS.has(key) || KNOWN_OPTIONAL.has(key), `writer emitted unknown field ${key}`);
      }
      for (const key of V05_FIELDS) assert.ok(key in ev, `writer dropped v05 field ${key}`);
      // New optional fields stay out of the hash: strip them and the chain
      // still verifies, so a v0.5 reader can check integrity.
      const { hash, server_time: _s, origin_seq: _o, origin_device: _d, ...core } = ev;
      void _s; void _o; void _d;
      assert.equal(hashFor(core as Parameters<typeof hashFor>[0]), hash);
    }
  });
});
