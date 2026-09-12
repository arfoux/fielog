import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, logPathFor } from '../src/kernel.ts';

describe('kernel-skipped', () => {
  it('poison line is surfaced via health/verifyLog with a warn on every reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-skipped-'));
    const file = join(dir, 'ledger.db');
    const k1 = await createKernel({ file });
    await k1.append({ type: 'entry', value: 1, actor: 'device' });
    k1.close();

    // Tamper the log payload in place (hash no longer matches).
    const logPath = logPathFor(file);
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length >= 1);
    const ev = JSON.parse(lines[0]) as Record<string, unknown>;
    ev.payload = { value: 999999, tampered: true };
    lines[0] = JSON.stringify(ev);
    writeFileSync(logPath, lines.join('\n') + '\n');

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg?: unknown, ...rest: unknown[]) => {
      warns.push(String(msg));
      void rest;
    };
    try {
      const k2 = await createKernel({ file });
      try {
        assert.equal(k2.health().skipped, 1);
        assert.equal(k2.verifyLog().skipped, 1);
        assert.ok(warns.some((w) => w.includes('WARN_REPLAY_SKIPPED')), 'expected reopen warn');
        // Second reopen: still loud, never a silent skip.
        k2.close();
      } catch (e) {
        try { k2.close(); } catch { /* gone */ }
        throw e;
      }
      warns.length = 0;
      const k3 = await createKernel({ file });
      try {
        assert.equal(k3.health().skipped, 1);
        assert.ok(warns.some((w) => w.includes('WARN_REPLAY_SKIPPED')), 'expected warn on every reopen');
      } finally {
        k3.close();
      }
    } finally {
      console.warn = origWarn;
    }
  });

  it('clean log reports skipped 0 with no warn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-skipped-clean-'));
    const file = join(dir, 'ledger.db');
    const k1 = await createKernel({ file });
    await k1.append({ type: 'entry', value: 1, actor: 'device' });
    k1.close();

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg?: unknown) => { warns.push(String(msg)); };
    try {
      const k2 = await createKernel({ file });
      try {
        assert.equal(k2.health().skipped, 0);
        assert.equal(k2.verifyLog().skipped, undefined);
        assert.ok(!warns.some((w) => w.includes('WARN_REPLAY_SKIPPED')));
      } finally {
        k2.close();
      }
    } finally {
      console.warn = origWarn;
    }
  });
});
