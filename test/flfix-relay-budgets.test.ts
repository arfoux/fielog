// flfix-relay-budgets: regression tests for the relay.ts DoS budgets (RvSec-1).
// (1) MAX_BATCH_EVENTS on push, (2) MAX_EVENT_BYTES on push — both rejected
// with bad_batch BEFORE store; (3) pull pagination cap with a global cursor
// (+ bad_cursor parity with revoke_pull); (4) startup file-size guard.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsRelayServer, WsRelayClient } from '../src/relay.ts';
import type { LogEvent } from '../src/log.ts';

const fast = { baseMs: 1, maxMs: 30 };

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) {
    try {
      closers.pop()?.();
    } catch {
      /* closing */
    }
  }
});

let seq = 0;
function mkEv(id: string): LogEvent {
  seq += 1;
  return {
    id,
    seq,
    type: 'entry',
    device_id: 'device-test',
    ts_device: Date.now(),
    payload: { value: 100 },
    prev_hash: 'GENESIS',
    hash: `hash-${id}`,
  };
}

function openServer(opts: ConstructorParameters<typeof WsRelayServer>[0] = {}) {
  const server = new WsRelayServer({ port: 0, hbMs: 60_000, ...opts });
  closers.push(() => server.kill());
  return server;
}

function openClient(url: string, extra: Record<string, unknown> = {}) {
  const c = new WsRelayClient(url, { ...fast, ...extra });
  closers.push(() => c.close());
  return c;
}

interface RawPullOk {
  ok: true;
  events: LogEvent[];
  cursor: number;
}
interface RawPullErr {
  ok: false;
  code: string;
  message: string;
}
// Single raw pull_res page (no client pagination): the regression lens for
// the server-side pull cap. Ignores pings; matches on req.
async function rawPull(port: number, since: unknown): Promise<RawPullOk | RawPullErr> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  closers.push(() => {
    try {
      ws.close();
    } catch {
      /* closing */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('raw ws dial failed'));
  });
  const out = await new Promise<RawPullOk | RawPullErr>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('raw pull timed out')), 8000);
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg['op'] === 'pull_res' && msg['req'] === 1) {
        clearTimeout(timer);
        resolve({ ok: true, events: msg['events'] as LogEvent[], cursor: msg['cursor'] as number });
      } else if (msg['op'] === 'error' && msg['req'] === 1) {
        clearTimeout(timer);
        resolve({ ok: false, code: String(msg['code']), message: String(msg['message']) });
      }
      // pings / live hints: ignored, no heartbeat interference at hbMs 60s.
    };
    ws.send(JSON.stringify({ op: 'pull', req: 1, since }));
  });
  return out;
}

describe('flfix-relay-budgets', () => {
  it('push batch over maxBatchEvents is rejected before store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-bcap-'));
    const file = join(dir, 'relay.log');
    const server = openServer({ file, maxBatchEvents: 3 });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`);

    const over = [mkEv('b-cap-1'), mkEv('b-cap-2'), mkEv('b-cap-3'), mkEv('b-cap-4')];
    await assert.rejects(c.push(over), /bad_batch/);
    assert.equal(server.size, 0, 'over-budget batch must store nothing');
    assert.equal(readFileSync(file, 'utf8').includes('b-cap-1'), false, 'over-budget batch must persist nothing');

    // Boundary: exactly at the cap still stores.
    const at = [mkEv('b-cap-ok-1'), mkEv('b-cap-ok-2'), mkEv('b-cap-ok-3')];
    assert.deepEqual((await c.push(at)).acked, ['b-cap-ok-1', 'b-cap-ok-2', 'b-cap-ok-3']);
    assert.equal(server.size, 3);
  }, 30_000);

  it('oversize push event is rejected before store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-bytes-'));
    // Size the cap off a real event so the boundary is exact, not magic.
    const room = JSON.stringify(mkEv('b-size-probe')).length;
    const server = openServer({ file: join(dir, 'relay.log'), maxEventBytes: room + 100 });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`);

    const ok = await c.push([mkEv('b-bytes-ok')]);
    assert.deepEqual(ok.acked, ['b-bytes-ok']);

    const big = { ...mkEv('b-bytes-big'), payload: { blob: 'x'.repeat(2048) } };
    await assert.rejects(c.push([big]), /bad_batch/);
    assert.equal(server.size, 1, 'oversize event must store nothing');
  }, 30_000);

  it('pull pages are capped but the client still converges; bad cursors rejected', async () => {
    const server = openServer({ maxPullEvents: 3 });
    const port = await server.start();
    const c = openClient(`ws://127.0.0.1:${port}`);

    const batch: LogEvent[] = [];
    for (let i = 1; i <= 8; i++) batch.push(mkEv(`b-pull-${i}`));
    assert.equal((await c.push(batch)).acked.length, 8);

    // Raw single page: capped events, global cursor.
    const page = await rawPull(port, 0);
    assert.equal(page.ok, true, 'pull(0) must succeed');
    if (page.ok) {
      assert.equal(page.events.length, 3, 'one pull_res must not ship the whole tail');
      assert.equal(page.cursor, 8, 'cursor stays global so the client can paginate');
    }

    // Bad cursors: parity with revoke_pull bad_cursor, not slice coercion.
    const neg = await rawPull(port, -1);
    assert.equal(neg.ok, false, 'negative cursor must be rejected');
    if (!neg.ok) assert.equal(neg.code, 'bad_cursor');
    const frac = await rawPull(port, 2.5);
    assert.equal(frac.ok, false, 'fractional cursor must be rejected');
    if (!frac.ok) assert.equal(frac.code, 'bad_cursor');

    // The paginating client still converges over the capped server.
    const full = await c.pull(0);
    assert.equal(full.cursor, 8);
    assert.deepEqual(
      full.events.map((e) => e.id),
      batch.map((e) => e.id),
    );
  }, 30_000);

  it('startup refuses an oversized relay file instead of loading it into RAM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-flrelay-guard-'));
    const file = join(dir, 'relay.log');
    writeFileSync(file, JSON.stringify(mkEv('b-guard-1')) + '\n');

    assert.throws(() => new WsRelayServer({ file, maxFileBytes: 10 }), /oversized|budget/);

    // Normal load unaffected: the same file opens fine under the default cap.
    const ok = new WsRelayServer({ file });
    try {
      assert.equal(ok.size, 1);
    } finally {
      ok.kill();
    }
  }, 30_000);
});
