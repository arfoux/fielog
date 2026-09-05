// Stress: 10 clients push 20 events each concurrently; the relay lands
// exactly 200 unique UUIDs — concurrency is no excuse for duplicates.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, type Kernel } from '../src/kernel.ts';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';

const fast = { baseMs: 1, maxMs: 30 };
const CLIENTS = 10;
const PER_CLIENT = 20;

describe('stress 10 clients', () => {
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

  it('200 concurrent events land exact-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-stress-'));
    const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log') });
    closers.push(() => server.kill());
    const port = await server.start();

    const kernels: Kernel[] = [];
    const clients: WsRelayClient[] = [];
    for (let c = 0; c < CLIENTS; c++) {
      kernels.push(await createKernel({ file: join(dir, `hp${c}.db`) }));
      clients.push(new WsRelayClient(`ws://127.0.0.1:${port}`, { ...fast }));
    }
    closers.push(() => {
      for (const k of kernels) k.close();
      for (const c of clients) c.close();
    });

    let expected = 0;
    for (let c = 0; c < CLIENTS; c++) {
      for (let i = 0; i < PER_CLIENT; i++) {
        const nominal = 1000 + c * 100 + i;
        expected += nominal;
        await kernels[c].append({ type: 'bayar', nominal, oleh: `hp${c}` });
      }
    }
    // All ten sync at once over ten sockets.
    const results = await Promise.all(
      kernels.map((k, c) => k.sync(clients[c], { chunkSize: 7, maxRetries: 20, ...fast })),
    );
    for (const [c, r] of results.entries()) {
      assert.equal(r.acked, PER_CLIENT, `client ${c} acked short`);
    }
    assert.equal(server.size, CLIENTS * PER_CLIENT);
    const ids = server.storedIds();
    assert.equal(new Set(ids).size, CLIENTS * PER_CLIENT); // exact-once under concurrency

    // Every client sees the full picture after pulling.
    await Promise.all(kernels.map((k, c) => k.sync(clients[c], { ...fast })));
    for (const [c, k] of kernels.entries()) {
      const rows = await k.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
      assert.equal(rows[0].total, expected, `client ${c} total diverges`);
    }
  }, 60_000);
});
