// CLI signed surface: serve defaults to signed mode (needs --trust) and
// sync needs --key/--as; a forged device_id push is rejected by the relay.
// Regression: unsigned mode accepted any forged device_id.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDeviceKey } from '../src/auth.ts';

import { pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'bin', 'fielog.ts');
const BUN = process.execPath;

const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  while (procs.length) {
    try {
      procs.pop()?.kill(9);
    } catch {
      /* already dead */
    }
  }
});

async function waitPort(proc: ReturnType<typeof Bun.spawn>, ms = 15000): Promise<number> {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const end = Date.now() + ms;
  try {
    for (;;) {
      const m = buf.match(/port=(\d+)/);
      if (m) return Number(m[1]);
      if (Date.now() > end) throw new Error(`cli serve tak ready: ${buf.slice(0, 300)}`);
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (done) throw new Error(`cli serve died before ready: ${buf.slice(0, 300)}`);
    }
  } finally {
    reader.releaseLock();
  }
}

async function runOnce(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([BUN, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  procs.push(proc);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe('cli signed surface', () => {
  it('serve demands --trust without --unsigned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cliauth-'));
    const r = await runOnce(['serve', '--port', '0', '--file', join(dir, 'relay.log')]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--trust|--unsigned/);
  }, 30_000);

  it('sync demands --key/--as without --unsigned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cliauth-'));
    const r = await runOnce(['sync', '--file', join(dir, 'a.db'), '--relay', 'ws://127.0.0.1:1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--key|--unsigned/);
  }, 30_000);

  it('forged device_id push rejected, valid device syncs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cliauth-'));
    const victim = generateDeviceKey('kasir');
    const attacker = generateDeviceKey('attacker');
    const victimPub = join(dir, 'kasir.pub');
    const victimPriv = join(dir, 'kasir.priv');
    const attackerPriv = join(dir, 'attacker.priv');
    writeFileSync(victimPub, victim.publicKeyPem);
    writeFileSync(victimPriv, victim.privateKeyPem);
    writeFileSync(attackerPriv, attacker.privateKeyPem);
    const relayFile = join(dir, 'relay.log');

    const serve = Bun.spawn([BUN, CLI, 'serve', '--port', '0', '--file', relayFile, '--trust', `kasir=${victimPub}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(serve);
    const port = await waitPort(serve);
    const url = `ws://127.0.0.1:${port}`;

    const adb = join(dir, 'a.db');
    const kernelUrl = pathToFileURL(join(root, 'src', 'kernel.ts')).href;
    const prep = Bun.spawn([BUN, '-e', `
import { createKernel } from ${JSON.stringify(kernelUrl)};
const k = await createKernel({ file: ${JSON.stringify(adb)} });
await k.append({ type: 'bayar', nominal: 1000, oleh: 'toko' });
k.close();
    `], { stdout: 'pipe', stderr: 'pipe' });
    procs.push(prep);
    const prepErr = await new Response(prep.stderr).text();
    assert.equal(await prep.exited, 0, `prep failed: ${prepErr}`);

    // Attacker key claiming the victim device id: relay must reject.
    const forged = await runOnce(['sync', '--file', adb, '--relay', url, '--key', attackerPriv, '--as', 'kasir']);
    assert.notEqual(forged.code, 0, `forged push got through: ${forged.out} ${forged.err}`);
    assert.match(`${forged.out} ${forged.err}`, /rejected|forbidden/);
    assert.equal(readFileSync(relayFile, 'utf8').trim(), '', 'relay stored a forged event');

    // Victim key for its own id: accepted.
    const legit = await runOnce(['sync', '--file', adb, '--relay', url, '--key', victimPriv, '--as', 'kasir']);
    assert.equal(legit.code, 0, `valid sync failed: ${legit.err} ${legit.out}`);
    assert.match(legit.out, /acked=1/);
    serve.kill(9);
  }, 60_000);
});
