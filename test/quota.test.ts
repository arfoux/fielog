// quota-guard: reserve bytes before growing state, fail closed on doubt.
// Real files in tmpdir, byte-sized fixtures (no memory pressure by design).
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQuotaGuard } from '../src/quota.ts';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'fielog-quota-'));
}

describe('quota-guard reserve + fail-closed', () => {
  it('admits reservations within the ceiling with exact accounting', () => {
    const g = openQuotaGuard({ limitBytes: 100, files: [join(dir(), 'missing.log')] });
    assert.equal(g.usage(), 0); // missing file = provably empty, not unknown
    g.reserve(60);
    assert.equal(g.held(), 60);
    assert.deepEqual(g.status(), { limit: 100, used: 0, reserved: 60, remaining: 40 });
    g.reserve(40);
    assert.equal(g.remaining(), 0);
  });

  it('measures real files and denies the byte past the ceiling', () => {
    const d = dir();
    const f = join(d, 'kasir.log');
    writeFileSync(f, 'x'.repeat(40));
    const g = openQuotaGuard({ limitBytes: 100, files: [f] });
    assert.equal(g.usage(), 40);
    g.reserve(60); // 40 used + 60 held = 100: fits exactly
    assert.throws(
      () => g.reserve(1),
      (e: unknown) => e instanceof Error && e.message.startsWith('ERR_QUOTA_EXCEEDED: used 40 + held 60'),
    );
  });

  it('release frees capacity and clamps at zero', () => {
    const g = openQuotaGuard({ limitBytes: 10 });
    g.reserve(10);
    assert.throws(() => g.reserve(1), /ERR_QUOTA_EXCEEDED/);
    g.release(4);
    assert.equal(g.held(), 6);
    g.reserve(4);
    g.release(999); // over-release never throws, never goes negative
    assert.equal(g.held(), 0);
    g.reserve(10);
  });

  it('check catches growth behind the guard back (fail-closed on changed reality)', () => {
    const d = dir();
    const f = join(d, 'kasir.log');
    writeFileSync(f, 'x'.repeat(10));
    const g = openQuotaGuard({ limitBytes: 100, files: [f] });
    g.reserve(90); // 10 + 90 = 100: admitted
    appendFileSync(f, 'y'.repeat(50)); // someone else grew the file to 60
    assert.equal(g.usage(), 60);
    assert.throws(() => g.check(), /ERR_QUOTA_EXCEEDED: used 60 \+ held 90/);
    assert.throws(() => g.reserve(1), /ERR_QUOTA_EXCEEDED/);
  });

  it('fail-closed: unmeasurable usage denies instead of admitting blind', () => {
    const g = openQuotaGuard({ limitBytes: 100, files: ['quota-\0-unmeasurable'] });
    assert.throws(() => g.usage(), /ERR_QUOTA_UNKNOWN/);
    assert.throws(() => g.reserve(1), /ERR_QUOTA_UNKNOWN/);
    assert.throws(() => g.check(), /ERR_QUOTA_UNKNOWN/);
    assert.throws(() => g.remaining(), /ERR_QUOTA_UNKNOWN/);
    assert.throws(() => g.status(), /ERR_QUOTA_UNKNOWN/);
  });

  it('rejects bad limits and bad reservation sizes', () => {
    for (const bad of [0, -1, 1.5, NaN, undefined]) {
      assert.throws(() => openQuotaGuard({ limitBytes: bad as number }), /ERR_QUOTA_INVALID/, String(bad));
    }
    const g = openQuotaGuard({ limitBytes: 10 });
    for (const bad of [0, -5, 1.5, NaN]) {
      assert.throws(() => g.reserve(bad), /ERR_QUOTA_INVALID/, `reserve ${String(bad)}`);
      assert.throws(() => g.release(bad), /ERR_QUOTA_INVALID/, `release ${String(bad)}`);
    }
    assert.equal(g.held(), 0); // rejected calls hold nothing
  });
});
