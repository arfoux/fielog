// Relay durability: 30 events in, server killed, restarted on the same
// file — all 30 survive (fsync before ack) and the client resumes the rest.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';

const fast = { baseMs: 1, maxMs: 30 };

describe('relay restart', () => {
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

  it('30 events survive kill+restart and the client resumes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-restart-'));
    const file = join(dir, 'relay.log');
    const server = new WsRelayServer({ port: 0, file });
    const port = await server.start();

    const k = await createKernel({ file: join(dir, 'kasir.db') });
    closers.push(() => k.close());
    const client = new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast });
    closers.push(() => client.close());

    let expected = 0;
    for (let i = 0; i < 30; i++) {
      expected += 700 + i;
      await k.append({ type: 'bayar', nominal: 700 + i, oleh: 'toko' });
    }
    const up = await k.sync(client, { chunkSize: 10, ...fast });
    assert.equal(up.acked, 30);
    assert.equal(server.size, 30);

    server.kill(); // process death: nothing graceful, nothing flushed late

    const server2 = new WsRelayServer({ port, file });
    closers.push(() => server2.kill());
    await server2.start();
    assert.equal(server2.size, 30);
    const ids = server2.storedIds();
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 30);

    // Client works offline through the outage, then resumes on restart.
    for (let i = 0; i < 5; i++) {
      expected += 50 + i;
      await k.append({ type: 'bayar', nominal: 50 + i, oleh: 'toko' });
    }
    const re = await k.sync(client, { chunkSize: 10, maxRetries: 20, ...fast });
    assert.equal(re.acked, 5);
    assert.equal(k.ackSeq(), 35);
    assert.equal(server2.size, 35);

    const rows = await k.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    assert.equal(rows[0].total, expected);
  }, 30_000);
});
