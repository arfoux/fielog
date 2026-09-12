// relay-budget-bytes: (a) multibyte per-event bytes counted as UTF-8, not
// UTF-16 units; (b) pull pages bounded by a total-byte cap (maxPullTotalBytes).
// Raw sockets only (no WsRelayClient handshake) to stay independent of the
// revoke-budget work happening on the same file.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { WsRelayServer } from '../src/relay.ts';
import type { LogEvent } from '../src/log.ts';

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

let seq = 0;
function mkEv(body: string): LogEvent {
  seq += 1;
  return { id: `e${seq}`, ts: seq, device: 'd', kind: 'note', body } as LogEvent;
}

function openServer(opts: ConstructorParameters<typeof WsRelayServer>[0] = {}) {
  const s = new WsRelayServer({ port: 0, hbMs: 60_000, ...opts });
  closers.push(() => s.kill());
  return s;
}

async function openSock(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  closers.push(() => { try { ws.close(); } catch { /* gone */ } });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
  ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws open failed')); }, { once: true });
  await promise;
  return ws;
}

async function ask(ws: WebSocket, payload: unknown, req: number): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const timer = setTimeout(() => reject(new Error('reply timeout')), 5000);
  const onMsg = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (msg['req'] === req) {
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      resolve(msg);
    }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify(payload));
  return promise;
}

describe('relay-budget-bytes', () => {
  it('multibyte event bytes counted as UTF-8: euro payload over cap rejected', async () => {
    // '€' is 1 UTF-16 unit but 3 UTF-8 bytes; 400 of them = 400 units but
    // 1200 bytes. With maxEventBytes 1000, a .length check would accept.
    const server = openServer({ maxEventBytes: 1000 });
    const port = await server.start();
    const ws = await openSock(port);
    const reply = await ask(ws, { op: 'push', req: 1, events: [mkEv('€'.repeat(400))] }, 1);
    assert.equal(reply['op'], 'error');
    assert.equal(reply['code'], 'bad_batch');
    assert.equal(server.size, 0, 'oversize multibyte event must store nothing');
  });

  it('pull page truncated by total bytes with global cursor', async () => {
    const server = openServer({ maxPullTotalBytes: 300 });
    const port = await server.start();
    const ws = await openSock(port);
    let req = 0;
    for (let i = 0; i < 5; i++) {
      req += 1;
      const ack = await ask(ws, { op: 'push', req, events: [mkEv('x'.repeat(200))] }, req);
      assert.equal(ack['op'], 'push_ack');
    }
    req += 1;
    const page = await ask(ws, { op: 'pull', req, since: 0 }, req);
    assert.equal(page['op'], 'pull_res');
    assert.ok((page['events'] as unknown[]).length < 5, 'giant tail must not ship whole');
    assert.equal(page['cursor'], 5, 'cursor stays global so the client can paginate');
    // Paginate to convergence with since += events.length (one per page here).
    let got = (page['events'] as unknown[]).length;
    let since = got;
    while (since < (page['cursor'] as number)) {
      req += 1;
      const rest = await ask(ws, { op: 'pull', req, since }, req);
      assert.equal(rest['op'], 'pull_res');
      assert.ok((rest['events'] as unknown[]).length >= 1, 'pages must make progress');
      got += (rest['events'] as unknown[]).length;
      since += (rest['events'] as unknown[]).length;
    }
    assert.equal(got, 5);
  });

  it('single event larger than the pull total is an explicit too_large error', async () => {
    const server = openServer({ maxEventBytes: 100_000, maxPullTotalBytes: 100 });
    const port = await server.start();
    const ws = await openSock(port);
    const ack = await ask(ws, { op: 'push', req: 1, events: [mkEv('y'.repeat(500))] }, 1);
    assert.equal(ack['op'], 'push_ack');
    const reply = await ask(ws, { op: 'pull', req: 2, since: 0 }, 2);
    assert.equal(reply['op'], 'error');
    assert.equal(reply['code'], 'too_large');
  });
});
