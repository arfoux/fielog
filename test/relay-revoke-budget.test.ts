// relay-revoke-budget: giant anonymous revoke_push batches are rejected
// cheaply (bad_batch) BEFORE per-event ed25519 verify/merge; raw frames past
// the byte cap are rejected pre-parse. Pre-fix logic merged the whole batch
// (unbounded verifies) and parsed unbounded frames — these tests FAIL there:
// the 5000-forgery batch would be verify-attempted, and the raw-frame test
// would get revoke_ack instead of bad_batch.
import { describe, it, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { WsRelayServer } from '../src/relay.ts';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) {
    try {
      closers.pop()!();
    } catch {
      /* closing */
    }
  }
});

function openServer(opts: ConstructorParameters<typeof WsRelayServer>[0] = {}) {
  const server = new WsRelayServer({ port: 0, hbMs: 60_000, ...opts });
  closers.push(() => server.kill());
  return server;
}

function rawSend(port: number, payload: string, matchReq: number): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  closers.push(() => {
    try {
      ws.close();
    } catch {
      /* closing */
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('raw revoke timed out')), 8000);
    ws.onopen = () => ws.send(payload);
    ws.onerror = () => reject(new Error('raw ws dial failed'));
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg['req'] === matchReq && (msg['op'] === 'error' || msg['op'] === 'revoke_ack')) {
        clearTimeout(timer);
        resolve(msg);
      }
    };
  });
}

describe('relay-revoke-budget', () => {
  it('giant anonymous revoke_push batch is rejected without merge', async () => {
    const server = openServer({ maxRevokeBatchEvents: 5 });
    const port = await server.start();
    const forgeries = Array.from({ length: 5000 }, (_, i) => ({
      deviceId: `evil-${i}`,
      tokenId: '*',
      reason: 'spam',
      adminId: 'nobody',
      sig: '00'.repeat(64),
    }));
    const msg = await rawSend(port, JSON.stringify({ op: 'revoke_push', req: 7, events: forgeries }), 7);
    assert.equal(msg['op'], 'error', 'over-cap revoke batch must be rejected');
    assert.equal(msg['code'], 'bad_batch');
    assert.equal(server.revokes.size, 0, 'rejected batch must merge nothing');
  }, 30_000);

  it('oversize raw frame is rejected pre-parse with bad_batch', async () => {
    const server = openServer({ maxRawMessageBytes: 200 });
    const port = await server.start();
    // Valid-shape revoke_push, but the raw frame exceeds the byte cap.
    const payload = JSON.stringify({
      op: 'revoke_push',
      req: 9,
      events: [{ deviceId: 'd', tokenId: '*', reason: 'x'.repeat(500), adminId: 'a', sig: '00'.repeat(64) }],
    });
    assert.ok(payload.length > 200, 'payload must exceed the tiny test cap');
    const msg = await rawSend(port, payload, 9);
    assert.equal(msg['op'], 'error', 'oversize frame must be rejected');
    assert.equal(msg['code'], 'bad_batch');
    assert.equal(server.revokes.size, 0, 'oversize frame must merge nothing');
  }, 30_000);
});
