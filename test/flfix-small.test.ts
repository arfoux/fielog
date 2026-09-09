// flfix-small: audit-suspect regressions for revokelog / tombstone / quota /
// hashchain / index. Each test pins the fixed contract; pre-fix the
// order-dependent, negative-remaining, orphan-show, unsigned-append, and
// missing-export cases fail.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { openStore, type EventStore } from '../src/store.ts';
import type { LogEvent } from '../src/log.ts';
import { generateDeviceKey } from '../src/auth.ts';
import { RevokeLog, createRevokeEvent, REVOKE_GENESIS } from '../src/revokelog.ts';
import { TOMBSTONE_HIDE, TOMBSTONE_SHOW, guardSeal, hide } from '../src/tombstone.ts';
import { openQuotaGuard } from '../src/quota.ts';
import { openHashChain } from '../src/hashchain.ts';
import {
  authorizeCapToken,
  authorizeGrant,
  canonicalGrant,
  CapRevocationList,
  CAP_TOKEN_TTL_MS,
  generateDeviceKey as genKeyFromIndex,
  GRANT_TTL_MS,
  mintCapToken,
} from '../src/index.ts';

function mkEv(seq: number, id: string, type: string, payload: Record<string, unknown> = {}): LogEvent {
  return {
    id, seq, type, device_id: 'd1', ts_device: 1, payload, prev_hash: 'GENESIS', hash: `h${seq}`,
  };
}

function memStore(): { store: EventStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-small-'));
  const store = openStore(join(dir, 't.db'));
  return { store, done: () => store.close() };
}

describe('flfix-small audit suspects', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) {
      try {
        closers.pop()!();
      } catch {
        /* gone */
      }
    }
  });

  it('revokedTokens breaks epoch ties by min hash, not arrival order', () => {
    const admin = generateDeviceKey('flfix-admin');
    const registry = new Map([[admin.deviceId, admin.publicKeyPem]]);
    // Independent roots (both prev = GENESIS) so merge preserves batch order.
    const e1 = createRevokeEvent(
      admin.privateKeyPem, admin.deviceId,
      { tokenId: 'tok', deviceId: 'dev-A', epoch: 1 }, REVOKE_GENESIS,
    );
    const e2 = createRevokeEvent(
      admin.privateKeyPem, admin.deviceId,
      { tokenId: 'tok', deviceId: 'dev-B', epoch: 1 }, REVOKE_GENESIS,
    );
    assert.notEqual(e1.hash, e2.hash);
    const low = e1.hash < e2.hash ? e1 : e2;
    const c = new RevokeLog(registry);
    c.merge([e1, e2]);
    const d = new RevokeLog(registry);
    d.merge([e2, e1]);
    // Same convergent row regardless of which replica saw which first.
    assert.deepEqual(c.revokedTokens(), d.revokedTokens());
    assert.equal(c.revokedTokens()[0].deviceId, low.deviceId);
  });

  it('guardSeal clamps a seal that would strand a show without its target', () => {
    const { store, done } = memStore();
    closers.push(done);
    store.apply(mkEv(1, 't1', 'note'));
    store.apply(mkEv(2, 'h1', TOMBSTONE_HIDE, { hides: 't1' }));
    store.apply(mkEv(3, 's1', TOMBSTONE_SHOW, { shows: 't1' }));
    // Seal 2 sweeps target+hide but leaves the show orphaned: clamp below all.
    const split = guardSeal(store, [1, 2, 3], 2, 5);
    assert.equal(split.effective, 0);
    assert.deepEqual(split.pairs, [{ target: 1, hide: 3 }]);
    // Whole-prefix seal keeps the triple together and sweeps cleanly.
    const whole = guardSeal(store, [1, 2, 3], 3, 5);
    assert.equal(whole.effective, 3);
    assert.deepEqual(whole.pairs, []);
  });

  it('hide fails fast on unknown targets and duplicate hides stay safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-hide-'));
    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    const a = await k.append({ type: 'note', payload: { isi: 'struk-1' } });
    const before = k.health().events;
    // Unknown target: throws before appending, so no poison line is left.
    // (Check-then-append is documented non-atomic: concurrent writers must
    // serialize hide() behind the kernel append lock. Duplicates are safe —
    // the fold stays hidden — so retry-after-racy-check never corrupts.)
    await assert.rejects(hide(k, 'no-such-id'), /ERR_UNKNOWN_TARGET/);
    assert.equal(k.health().events, before);
    await hide(k, a.id, { reason: 'wrong value input' });
    await hide(k, a.id, { reason: 'racy retry' });
    const rows = await k.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM records WHERE type = '${TOMBSTONE_HIDE}'`,
    );
    assert.equal(rows[0].n, 2);
  });

  it('quota remaining never goes negative; denial stays loud', () => {
    const d = mkdtempSync(join(tmpdir(), 'fielog-flfix-quota-'));
    const f = join(d, 'ledger.log');
    writeFileSync(f, 'x'.repeat(10));
    const g = openQuotaGuard({ limitBytes: 100, files: [f] });
    g.reserve(90); // 10 used + 90 held = 100: admitted
    appendFileSync(f, 'y'.repeat(50)); // someone else grew the file behind our back
    assert.equal(g.usage(), 60);
    assert.equal(g.remaining(), 0); // clamped: zero headroom, never -50
    assert.equal(g.status().remaining, 0);
    assert.throws(() => g.check(), /ERR_QUOTA_EXCEEDED/); // but denial still throws
    assert.throws(() => g.reserve(1), /ERR_QUOTA_EXCEEDED/);
  });

  it('quota files list is a snapshot; over-release absorbs at zero', () => {
    const d = mkdtempSync(join(tmpdir(), 'fielog-flfix-qfiles-'));
    const small = join(d, 'a.log');
    const big = join(d, 'b.log');
    writeFileSync(small, 'x'.repeat(8));
    writeFileSync(big, 'y'.repeat(900));
    const files = [small];
    const g = openQuotaGuard({ limitBytes: 1000, files });
    files.push(big); // mutating the caller array must not widen the measure
    assert.equal(g.usage(), 8);
    // Unbalanced release never throws and never goes negative: held pins at
    // zero, so callers must pair every reserve with exactly one release.
    g.reserve(10);
    g.release(999);
    assert.equal(g.held(), 0);
  });

  it('openHashChain forwards the signer to the log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flfix-hash-'));
    const c = openHashChain(join(dir, 'rantang.log'), 'dev-1', (ev) => `sig-${ev.hash}`);
    try {
      const e = c.append({ type: 'catat', payload: { n: 1 } });
      assert.equal(e.signature, `sig-${e.hash}`);
      assert.deepEqual(c.verify(), { ok: true });
    } finally {
      c.close();
    }
  });

  it('index exports the full authorize surface (no deep-import needed)', () => {
    assert.equal(GRANT_TTL_MS, 24 * 3600 * 1000);
    assert.equal(CAP_TOKEN_TTL_MS, 15 * 60 * 1000);
    assert.equal(typeof canonicalGrant, 'function');
    assert.equal(typeof authorizeCapToken, 'function');
    assert.equal(typeof authorizeGrant, 'function');
    assert.equal(typeof genKeyFromIndex, 'function');
    const dev = genKeyFromIndex('idx-dev');
    const now = Date.now();
    const token = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push'], CAP_TOKEN_TTL_MS, now);
    assert.deepEqual(
      authorizeCapToken({ publicKeyPem: dev.publicKeyPem, token, scope: 'relay:push', now }),
      { ok: true },
    );
    const gated = authorizeCapToken({
      publicKeyPem: dev.publicKeyPem,
      token,
      scope: 'relay:push',
      revokedDevices: new Set([dev.deviceId]),
      now,
    });
    assert.equal(gated.ok, false);
    const rev = new CapRevocationList();
    rev.revoke(token.id);
    assert.equal(
      authorizeCapToken({ publicKeyPem: dev.publicKeyPem, token, scope: 'relay:push', revocations: rev, now }).ok,
      false,
    );
  });
});
