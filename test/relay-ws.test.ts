// Relay over a real socket: two clients share, kill+restart resumes
// exact-once, chaos drops still converge. Bun.serve, no extra deps.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';

const fast = { baseMs: 1, maxMs: 30 };

// Real sockets: fake timers cannot drive ws i/o, so poll for the awaited
// condition with a deadline instead of sleeping a fixed duration.
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function unique(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

describe('ws relay', () => {
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

  it('two clients share events with heartbeat and live broadcast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-ws-'));
    const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log'), hbMs: 100 });
    closers.push(() => server.kill());
    const port = await server.start();

    const ka = await createKernel({ file: join(dir, 'a.db') });
    const kb = await createKernel({ file: join(dir, 'b.db') });
    closers.push(() => ka.close(), () => kb.close());
    const ca = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast });
    const cb = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast });
    closers.push(() => ca.close(), () => cb.close());

    // Connect b first so it witnesses the live broadcast (a hint, not truth).
    assert.deepEqual(await cb.pull(0), { events: [], cursor: 0 });

    let expected = 0;
    for (let i = 0; i < 10; i++) {
      expected += 1000 + i;
      await ka.append({ type: 'entry', value: 1000 + i, actor: 'budi' });
    }
    const up = await ka.sync(ca, { chunkSize: 5, ...fast });
    assert.equal(up.acked, 10);
    assert.equal(server.size, 10);

    await waitFor(() => cb.liveCount >= 10);
    const down = await kb.sync(cb, { ...fast });
    assert.equal(down.applied, 10);
    const rows = await kb.query<{ total: number }>(`SELECT SUM(value) AS total FROM entries WHERE voided = 0`);
    assert.equal(rows[0].total, expected);

    await waitFor(() => ca.pingsReceived > 0 && server.pongsReceived > 0);
  }, 30_000);

  it('kill mid-batch then restart resumes exact-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-wskill-'));
    const file = join(dir, 'relay.log');
    const server = new WsRelayServer({ port: 0, file, hbMs: 20 });
    const port = await server.start();
    server.crashAfter = 3; // die storing the 3rd chunk, before its ack

    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    const client = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast });
    closers.push(() => client.close());
    for (let i = 0; i < 30; i++) {
      await k.append({ type: 'entry', value: 500 + i, actor: 'ani' });
    }
    await assert.rejects(k.sync(client, { chunkSize: 5, maxRetries: 3, ...fast }), /dropped|failed|refused|closed|timeout/);
    assert.ok(k.ackSeq() < 30); // cursor stuck where the ack stopped

    const server2 = new WsRelayServer({ port, file, hbMs: 20 });
    closers.push(() => server2.kill());
    await server2.start();
    const res = await k.sync(client, { chunkSize: 5, maxRetries: 20, ...fast });
    assert.equal(res.acked, 20); // chunks 1-2 acked pre-crash; 3-6 reclaimed on resume
    assert.equal(k.ackSeq(), 30);

    const ids = server2.storedIds();
    assert.equal(ids.length, 30);
    assert.ok(unique(ids)); // re-pushed chunks deduped by UUID: exact-once
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 30);
  }, 30_000);

  it('chaos: 50 percent drops still converge exact-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-wschaos-'));
    const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log'), dropRate: 0.5, seed: 7 });
    closers.push(() => server.kill());
    const port = await server.start();

    const k = await createKernel({ file: join(dir, 'ledger.db') });
    closers.push(() => k.close());
    const client = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast, maxRetries: 30 });
    closers.push(() => client.close());
    for (let i = 0; i < 20; i++) {
      await k.append({ type: 'entry', value: 200 + i, actor: 'chaos' });
    }
    await k.sync(client, { chunkSize: 4, maxRetries: 40, ...fast });
    assert.equal(k.ackSeq(), 20);
    assert.ok(client.reconnects > 0); // the storm actually hit
    const ids = server.storedIds();
    assert.equal(ids.length, 20);
    assert.ok(unique(ids));
  }, 60_000);
});
