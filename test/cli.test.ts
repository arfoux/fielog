// cli lewat child process: serve+sync roundtrip 20 event exact-once,
// demo keluar 0 dengan total cocok. Bun only.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'bin', 'fielog.ts');
const BUN = process.execPath;

const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  while (procs.length) {
    try {
      procs.pop()?.kill(9);
    } catch {
      /* sudah mati */
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
      if (done) throw new Error(`cli serve mati sebelum ready: ${buf.slice(0, 300)}`);
    }
  } finally {
    reader.releaseLock();
  }
}

async function runOnce(args: string[], ms = 30000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([BUN, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  procs.push(proc);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  void ms;
  return { code, out, err };
}

describe('cli', () => {
  it('serve+sync roundtrip 20 event exact-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-cli-'));
    const relayFile = join(dir, 'relay.log');
    const adb = join(dir, 'a.db');
    const bdb = join(dir, 'b.db');

    const serve = Bun.spawn([BUN, CLI, 'serve', '--port', '0', '--file', relayFile, '--unsigned'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(serve);
    const port = await waitPort(serve);
    const url = `ws://127.0.0.1:${port}`;

    let expected = 0;
    const ka = await createKernel({ file: adb });
    for (let i = 0; i < 20; i++) {
      const nominal = 5000 + i * 250;
      expected += nominal;
      await ka.append({ type: 'bayar', nominal, oleh: 'kasir-1' });
    }
    ka.close();

    const up = await runOnce(['sync', '--file', adb, '--relay', url, '--unsigned']);
    assert.equal(up.code, 0, `sync a gagal: ${up.err} ${up.out}`);
    assert.match(up.out, /acked=20/);

    const down = await runOnce(['sync', '--file', bdb, '--relay', url, '--unsigned']);
    assert.equal(down.code, 0, `sync b gagal: ${down.err} ${down.out}`);
    assert.match(down.out, /applied=20/);

    const kb = await createKernel({ file: bdb });
    try {
      const rows = await kb.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
      assert.equal(rows[0].total, expected);
      const n = await kb.query<{ n: number }>(`SELECT COUNT(*) AS n FROM bayar WHERE voided = 0`);
      assert.equal(n[0].n, 20);
    } finally {
      kb.close();
    }

    // exact-once: file relay 20 uuid unik, sync ulang idempoten
    const ids = readFileSync(relayFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { id: string }).id);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);

    const again = await runOnce(['sync', '--file', bdb, '--relay', url, '--unsigned']);
    assert.equal(again.code, 0, `sync ulang gagal: ${again.err}`);
    assert.match(again.out, /applied=0/);
    serve.kill(9);
  }, 60_000);

  it('demo keluar 0 dengan total cocok', async () => {
    const r = await runOnce(['demo'], 60_000);
    assert.equal(r.code, 0, `demo gagal: ${r.err} ${r.out}`);
    const m = r.out.match(/hp1 = (\d+) \| hp2 = (\d+)/);
    assert.ok(m, `demo tak cetak total: ${r.out.slice(0, 300)}`);
    assert.equal(m[1], m[2]);
    assert.ok(Number(m[1]) > 0);
    assert.match(r.out, /total cocok/);
  }, 60_000);
});
