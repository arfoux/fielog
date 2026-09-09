// flfix-perf-relay: bounded-work regression tests for two relay.ts hot paths.
// (1) liveBuf keeps a persistent id Set: no per-message rebuild.
// (2) per-message token-revoke verdicts are cached on revokes.size.
// Spy-count assertions fail on the pre-fix code and pass after.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { WsRelayServer, WsRelayClient, MAX_LIVE_HINTS } from '../src/relay.ts';
import { RevokeLog } from '../src/revokelog.ts';
import { generateDeviceKey, mintCapToken, type CapToken } from '../src/auth.ts';
import type { LogEvent } from '../src/log.ts';

let seq = 0;
function mkEv(id: string): LogEvent {
  seq += 1;
  return {
    id,
    seq,
    type: 'payment',
    device_id: 'device-test',
    ts_device: Date.now(),
    payload: { amount: 100 },
    prev_hash: 'GENESIS',
    hash: `hash-${id}`,
  };
}
function liveRaw(evs: LogEvent[]): string {
  return JSON.stringify({ op: 'live', events: evs });
}

describe('flfix-perf-relay', () => {
  it('live hints dedupe without rebuilding an id set per message', () => {
    const c = new WsRelayClient('ws://127.0.0.1:1', { baseMs: 1, maxMs: 5 });
    try {
      const seam = c as unknown as {
        liveBuf: LogEvent[];
        liveIds: Set<string>;
        onMessage(raw: string): void;
      };
      // Persistent index exists and starts in lockstep with the buffer.
      assert.ok(seam.liveIds instanceof Set, 'client keeps a persistent live id set');
      assert.equal(seam.liveIds.size, 0);

      const buf = seam.liveBuf;
      let maps = 0;
      const proto = Array.prototype as unknown as { map: unknown };
      const origMap = proto.map;
      proto.map = function (this: unknown, ...args: unknown[]) {
        if (this === buf) maps += 1;
        return (origMap as (...a: unknown[]) => unknown).apply(this, args);
      };
      try {
        const N = 50;
        for (let i = 0; i < N; i++) seam.onMessage(liveRaw([mkEv(`perf-live-${i}`)]));
        assert.equal(maps, 0, `live path rebuilt an id set from the array on ${maps}/${N} messages`);
      } finally {
        proto.map = origMap;
      }

      assert.equal(c.liveCount, 50);
      assert.equal(seam.liveIds.size, 50, 'id set tracks every buffered hint');
      for (const e of seam.liveBuf) assert.ok(seam.liveIds.has(e.id));

      // Duplicates collapse: repeat the same batch, nothing grows.
      const dup = seam.liveBuf.slice(0, 10);
      seam.onMessage(liveRaw(dup));
      assert.equal(c.liveCount, 50);
      assert.equal(seam.liveIds.size, 50);
    } finally {
      c.close();
    }
  });

  it('live cap eviction drops ids from the persistent set', () => {
    const c = new WsRelayClient('ws://127.0.0.1:1', { baseMs: 1, maxMs: 5 });
    try {
      const seam = c as unknown as {
        liveBuf: LogEvent[];
        liveIds: Set<string>;
        onMessage(raw: string): void;
      };
      const total = MAX_LIVE_HINTS + 50;
      for (let i = 0; i < total; i++) seam.onMessage(liveRaw([mkEv(`perf-cap-${i}`)]));
      assert.equal(c.liveCount, MAX_LIVE_HINTS);
      assert.equal(seam.liveIds.size, MAX_LIVE_HINTS, 'evicted hints leave the id set');
      for (const e of seam.liveBuf) assert.ok(seam.liveIds.has(e.id));
      assert.ok(!seam.liveIds.has('perf-cap-0'), 'oldest evicted id is forgotten');
      // A forgotten id may return as a fresh hint (pull stays source of truth).
      seam.onMessage(liveRaw([mkEv('perf-cap-0')]));
      assert.ok(seam.liveIds.has('perf-cap-0'));
      assert.equal(c.liveCount, MAX_LIVE_HINTS);
    } finally {
      c.close();
    }
  });

  it('repeated authorize with a stable revoke log scans once', () => {
    const dev = generateDeviceKey('device-a');
    const server = new WsRelayServer({
      trustedDevices: { [dev.deviceId]: dev.publicKeyPem },
    });
    try {
      const gate = server as unknown as {
        authorize(ws: { send(s: string): void }, req: number, token: CapToken | undefined, scope: string): boolean;
      };
      const ws = { send(_s: string): void {} };
      const token = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull']);

      const orig = RevokeLog.prototype.isRevoked;
      let calls = 0;
      RevokeLog.prototype.isRevoked = function (tokenId: string, tokenEpoch = 0): boolean {
        calls += 1;
        return orig.call(this, tokenId, tokenEpoch);
      };
      try {
        const N = 50;
        for (let i = 0; i < N; i++) assert.equal(gate.authorize(ws, i, token, 'relay:push'), true);
        assert.equal(calls, 1, `stable log scanned ${calls} time(s) for ${N} gated messages`);
      } finally {
        RevokeLog.prototype.isRevoked = orig;
      }
    } finally {
      server.kill();
    }
  });

  it('verdict cache invalidates on log mutation and keys on epoch', () => {
    const dev = generateDeviceKey('device-a');
    const admin = generateDeviceKey('admin-1');
    const server = new WsRelayServer({
      trustedDevices: { [dev.deviceId]: dev.publicKeyPem },
    });
    server.addRevokeAdmin(admin.deviceId, admin.publicKeyPem);
    try {
      const gate = server as unknown as {
        authorize(ws: { send(s: string): void }, req: number, token: CapToken | undefined, scope: string): boolean;
      };
      const ws = { send(_s: string): void {} };
      const token = mintCapToken(dev.privateKeyPem, dev.deviceId, ['relay:push', 'relay:pull']);

      const orig = RevokeLog.prototype.isRevoked;
      let calls = 0;
      RevokeLog.prototype.isRevoked = function (tokenId: string, tokenEpoch = 0): boolean {
        calls += 1;
        return orig.call(this, tokenId, tokenEpoch);
      };
      try {
        assert.equal(gate.authorize(ws, 1, token, 'relay:push'), true);
        assert.equal(calls, 1);
        assert.equal(gate.authorize(ws, 2, token, 'relay:push'), true);
        assert.equal(calls, 1, 'stable-log repeat must hit the cache');

        // Mutation bumps revokes.size: the stale "not revoked" verdict dies.
        server.issueRevoke(admin.privateKeyPem, admin.deviceId, {
          tokenId: token.id,
          deviceId: dev.deviceId,
          epoch: 1,
        });
        assert.equal(gate.authorize(ws, 3, token, 'relay:push'), false, 'revoked token is rejected after the log grows');
        assert.equal(calls, 2, 'mutation forces exactly one rescan');
        assert.equal(gate.authorize(ws, 4, token, 'relay:push'), false);
        assert.equal(calls, 2, 'post-mutation verdict re-caches');

        // Epoch is part of the key: distinct epochs scan once each, then hit.
        const before = calls;
        for (let i = 0; i < 3; i++) server.isTokenRevoked('epoch-tok', 0);
        for (let i = 0; i < 3; i++) server.isTokenRevoked('epoch-tok', 5);
        assert.equal(calls - before, 2, 'one scan per epoch, repeats cached');
      } finally {
        RevokeLog.prototype.isRevoked = orig;
      }
    } finally {
      server.kill();
    }
  });
});
