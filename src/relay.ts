// relay.ts — real ws transport over Bun.serve, no extra deps.
// The relay stays dumb: accept raw log, broadcast, store. No business logic.
// Crash model: the server persists every stored event to a JSONL file BEFORE
// acking, so kill+restart + client resume from the ack cursor is exact-once
// by UUID. Live broadcast is a hint only — pull is the source of truth.
import { existsSync, fsyncSync, mkdirSync, openSync, closeSync, readFileSync, writeSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import type { LogEvent } from './log.js';
import { backoffMs, type PushAck, type Relay } from './sync.js';
import { verifyCapToken, type CapToken } from './auth.js';

export interface WsRelayServerOpts {
  port?: number; // 0 = ephemeral (read back via .port)
  file?: string; // JSONL persistence; reloaded on boot
  hbMs?: number; // server ping interval
  dropRate?: number; // chaos 0..1: fraction of inbound msgs dropped (deterministic)
  seed?: number; // chaos rng seed
  /** Pre-trusted devices: deviceId -> ed25519 publicKeyPem. Enforcement is on when non-empty. */
  trustedDevices?: Record<string, string>;
}

type ToServer =
  | { op: 'push'; req: number; events: LogEvent[]; token?: CapToken }
  | { op: 'pull'; req: number; since: number; token?: CapToken }
  | { op: 'pong' };

type ToClient =
  | { op: 'push_ack'; req: number; acked: string[]; server_time: number }
  | { op: 'pull_res'; req: number; events: LogEvent[]; cursor: number }
  | { op: 'live'; events: LogEvent[] }
  | { op: 'revoked'; deviceId: string }
  | { op: 'error'; req: number; code: string; message: string }
  | { op: 'ping' };

/** Deterministic rng so chaos tests reproduce. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SockState {
  lastPong: number;
}

export class WsRelayServer {
  private byId = new Map<string, LogEvent>();
  private order: LogEvent[] = [];
  private server: Server<SockState> | null = null;
  private sockets = new Set<ServerWebSocket<SockState>>();
  private hbTimer: Timer | undefined = undefined;
  private logFd: number | null = null;
  private rng: () => number;
  private devices = new Map<string, string>(); // deviceId -> publicKeyPem
  private revoked = new Set<string>(); // deviceIds; tombstones broadcast + persisted
  serverTime = 1_700_000_000_000;
  pushesReceived = 0;
  pullsReceived = 0;
  pongsReceived = 0;
  rejectsReceived = 0;
  /** Test hook: kill the server after this many push messages (crash, no ack). */
  crashAfter: number | null = null;

  constructor(private opts: WsRelayServerOpts = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    if (opts.trustedDevices) {
      for (const [id, pem] of Object.entries(opts.trustedDevices)) this.devices.set(id, pem);
    }
    if (opts.file && existsSync(opts.file)) {
      for (const line of readFileSync(opts.file, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t) as LogEvent;
          if (!this.byId.has(ev.id)) {
            this.byId.set(ev.id, ev);
            this.order.push(ev);
          }
        } catch {
          /* corrupt relay line: not an event, skip on reload */
        }
      }
    }
    this.loadRevocations();
  }

  /** Sidecar next to the event log; same file key, never mixed into event lines. */
  private revokeFile(): string | null {
    return this.opts.file ? this.opts.file + '.revocations' : null;
  }

  private loadRevocations(): void {
    const f = this.revokeFile();
    if (!f || !existsSync(f)) return;
    try {
      const ids = JSON.parse(readFileSync(f, 'utf8')) as string[];
      for (const id of ids) this.revoked.add(id);
    } catch {
      /* corrupt revoke sidecar: fail closed on listed ids only, keep serving */
    }
  }

  private persistRevocations(): void {
    const f = this.revokeFile();
    if (!f) return;
    const dir = dirname(f);
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(f, JSON.stringify([...this.revoked].sort()));
  }

  /** Trust a device key. Enforcement turns on once at least one device is known. */
  registerDevice(deviceId: string, publicKeyPem: string): void {
    this.devices.set(deviceId, publicKeyPem);
  }

  /** Revoke a device: future push/pull rejected, tombstone broadcast + persisted. */
  revokeDevice(deviceId: string): void {
    this.revoked.add(deviceId);
    this.persistRevocations();
    const msg = JSON.stringify({ op: 'revoked', deviceId } satisfies ToClient);
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        /* gone */
      }
    }
  }

  isRevoked(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }

  revokedIds(): string[] {
    return [...this.revoked].sort();
  }

  get enforcing(): boolean {
    return this.devices.size > 0;
  }

  get port(): number {
    if (!this.server) throw new Error('relay not started');
    return this.server.port ?? 0;
  }

  get size(): number {
    return this.byId.size;
  }

  /** Every stored UUID on disk, for exact-once audits. */
  storedIds(): string[] {
    return this.order.map((e) => e.id);
  }

  async start(): Promise<number> {
    const self = this;
    if (this.opts.file) {
      const dir = dirname(this.opts.file);
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
      this.logFd = openSync(this.opts.file, 'a');
    }
    this.server = Bun.serve<SockState>({
      port: this.opts.port ?? 0,
      fetch(req, server) {
        if (server.upgrade(req, { data: { lastPong: Date.now() } })) return;
        return new Response('fielog relay', { status: 200 });
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws);
        },
        close(ws) {
          self.sockets.delete(ws);
        },
        message(ws, raw) {
          self.onMessage(ws, String(raw));
        },
      },
    });
    const hbMs = this.opts.hbMs ?? 1000;
    this.hbTimer = setInterval(() => {
      const now = Date.now();
      for (const ws of [...this.sockets]) {
        if (now - ws.data.lastPong > hbMs * 3) {
          try {
            ws.close();
          } catch {
            /* gone */
          }
          continue;
        }
        try {
          ws.send(JSON.stringify({ op: 'ping' } satisfies ToClient));
        } catch {
          /* gone */
        }
      }
    }, hbMs);
    return this.port;
  }

  /** Abrupt kill: no graceful close, in-flight requests die unacked. */
  kill(): void {
    clearInterval(this.hbTimer);
    this.hbTimer = undefined;
    for (const ws of [...this.sockets]) {
      try {
        ws.close();
      } catch {
        /* gone */
      }
    }
    this.sockets.clear();
    if (this.logFd !== null) {
      try {
        closeSync(this.logFd);
      } catch {
        /* gone */
      }
      this.logFd = null;
    }
    this.server?.stop(true);
    this.server = null;
  }

  private persist(evs: LogEvent[]): void {
    if (!this.opts.file || evs.length === 0) return;
    if (this.logFd === null) return;
    writeSync(this.logFd, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fsyncSync(this.logFd); // durable before any ack: restart loses nothing
  }


  private onMessage(
    ws: ServerWebSocket<SockState>,
    raw: string,
  ): void {
    let msg: ToServer;
    try {
      msg = JSON.parse(raw) as ToServer;
    } catch {
      return;
    }
    if (msg.op === 'pong') {
      this.pongsReceived += 1;
      ws.data.lastPong = Date.now();
      return;
    }
    // Capability gate runs before chaos: rejected payloads are never stored.
    if (msg.op === 'push') {
      if (!this.authorize(ws, msg.req, msg.token, 'relay:push')) return;
    } else if (msg.op === 'pull') {
      if (!this.authorize(ws, msg.req, msg.token, 'relay:pull')) return;
    }
    // Chaos: message is dropped. Pushes are still stored first (write-ahead),
    // but no ack/response goes out and the socket dies — the client must
    // resume and the UUID dedupe must hold.
    if ((this.opts.dropRate ?? 0) > 0 && this.rng() < (this.opts.dropRate ?? 0)) {
      if (msg.op === 'push') this.store(msg.events);
      try {
        ws.close();
      } catch {
        /* gone */
      }
      return;
    }
    if (msg.op === 'push') {
      this.pushesReceived += 1;
      const fresh = this.store(msg.events);
      this.serverTime += 1;
      this.broadcast(fresh, ws);
      if (this.crashAfter !== null) {
        this.crashAfter -= 1;
        if (this.crashAfter <= 0) {
          this.crashAfter = null;
          this.kill(); // crash BEFORE ack: client resumes unacked work
          return;
        }
      }
      this.send(ws, { op: 'push_ack', req: msg.req, acked: msg.events.map((e) => e.id), server_time: this.serverTime });
    } else if (msg.op === 'pull') {
      this.pullsReceived += 1;
      const events = this.order.slice(msg.since);
      this.send(ws, { op: 'pull_res', req: msg.req, events, cursor: this.order.length });
    }
  }

  private authorize(
    ws: ServerWebSocket<SockState>,
    req: number,
    token: CapToken | undefined,
    scope: string,
  ): boolean {
    if (!this.enforcing) return true;
    const fail = (message: string): boolean => {
      this.rejectsReceived += 1;
      this.send(ws, { op: 'error', req, code: 'forbidden', message });
      return false;
    };
    if (!token) return fail('missing capability token');
    if (this.revoked.has(token.deviceId)) return fail(`device revoked: ${token.deviceId}`);
    const pem = this.devices.get(token.deviceId);
    if (!pem) return fail(`unknown device: ${token.deviceId}`);
    if (!verifyCapToken(pem, token, scope)) return fail(`capability rejected for ${scope}`);
    return true;
  }

  /** Store new UUIDs (persist first); returns the fresh ones for broadcast. */
  private store(batch: LogEvent[]): LogEvent[] {
    const fresh: LogEvent[] = [];
    for (const ev of batch) {
      if (!this.byId.has(ev.id)) {
        this.byId.set(ev.id, ev);
        this.order.push(ev);
        fresh.push(ev);
      }
    }
    this.persist(fresh); // write-ahead: durable before any ack
    return fresh;
  }

  private broadcast(evs: LogEvent[], except: ServerWebSocket<SockState>): void {
    if (evs.length === 0) return;
    const msg = JSON.stringify({ op: 'live', events: evs } satisfies ToClient);
    for (const ws of this.sockets) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        /* gone */
      }
    }
  }

  private send(ws: ServerWebSocket<SockState>, msg: ToClient): void {
    ws.send(JSON.stringify(msg));
  }
}

export interface WsRelayClientOpts {
  baseMs?: number;
  maxMs?: number;
  maxRetries?: number; // reconnect attempts per call
  reqTimeoutMs?: number;
  capToken?: CapToken; // capability token attached to every push/pull
}

interface Inflight {
  resolve: (m: ToClient) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

/** Relay over a real socket: reconnects with backoff+jitter, resumes via cursors. */
export class WsRelayClient implements Relay {
  private ws: WebSocket | null = null;
  private req = 0;
  private inflight = new Map<number, Inflight>();
  private manualClose = false;
  private liveBuf: LogEvent[] = [];
  private dials = 0;
  private capToken: CapToken | undefined;
  /** Revoke tombstones broadcast by the relay while this client was connected. */
  revokedNotices: string[] = [];
  pingsReceived = 0;
  reconnects = 0;

  constructor(
    private url: string,
    private opts: WsRelayClientOpts = {},
  ) {
    this.capToken = opts.capToken;
  }

  /** Swap the capability token (rotation / expiry refresh without redialling). */
  setCapToken(token: CapToken | undefined): void {
    this.capToken = token;
  }

  /** Live-broadcast hints received (pull stays the source of truth). */
  get liveCount(): number {
    return this.liveBuf.length;
  }

  private async ensureConn(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    const maxRetries = this.opts.maxRetries ?? 10;
    const baseMs = this.opts.baseMs ?? 50;
    const maxMs = this.opts.maxMs ?? 5000;
    let attempt = 0;
    for (;;) {
      try {
        this.ws = await this.dial();
        this.dials += 1;
        if (this.dials > 1) this.reconnects += 1;
        return this.ws;
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await new Promise((r) => setTimeout(r, backoffMs(attempt, baseMs, maxMs)));
        attempt += 1;
      }
    }
  }

  private dial(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const fail = (e: Event | Error) => {
        ws.onopen = ws.onerror = null;
        reject(e instanceof Error ? e : new Error('ws dial failed'));
      };
      ws.onerror = fail;
      ws.onopen = () => {
        ws.onmessage = (ev) => this.onMessage(String(ev.data));
        ws.onclose = () => this.onDrop(new Error('ws dropped'));
        ws.onerror = () => this.onDrop(new Error('ws error'));
        resolve(ws);
      };
    });
  }

  private onDrop(err: Error): void {
    this.ws = null;
    for (const [, f] of this.inflight) {
      clearTimeout(f.timer);
      f.reject(err);
    }
    this.inflight.clear();
  }

  private onMessage(raw: string): void {
    let msg: ToClient;
    try {
      msg = JSON.parse(raw) as ToClient;
    } catch {
      return;
    }
    if (msg.op === 'ping') {
      this.pingsReceived += 1;
      try {
        this.ws?.send(JSON.stringify({ op: 'pong' } satisfies ToServer));
      } catch {
        /* dropping */
      }
      return;
    }
    if (msg.op === 'live') {
      const known = new Set(this.liveBuf.map((e) => e.id));
      for (const ev of msg.events) {
        if (!known.has(ev.id)) {
          known.add(ev.id);
          this.liveBuf.push(ev);
        }
      }
      return;
    }
    if (msg.op === 'revoked') {
      if (!this.revokedNotices.includes(msg.deviceId)) this.revokedNotices.push(msg.deviceId);
      return;
    }
    const f = this.inflight.get((msg as { req: number }).req);
    if (!f) return;
    clearTimeout(f.timer);
    this.inflight.delete((msg as { req: number }).req);
    f.resolve(msg);
  }

  private request(op: 'push' | 'pull', body: Record<string, unknown>): Promise<ToClient> {
    const reqTimeoutMs = this.opts.reqTimeoutMs ?? 10_000;
    return (async () => {
      const ws = await this.ensureConn();
      const req = ++this.req;
      const { promise, resolve, reject } = Promise.withResolvers<ToClient>();
      const timer = setTimeout(() => {
        this.inflight.delete(req);
        reject(new Error(`relay req ${req} timed out`));
      }, reqTimeoutMs);
      this.inflight.set(req, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ op, req, ...(this.capToken ? { token: this.capToken } : {}), ...body }));
      } catch (e) {
        clearTimeout(timer);
        this.inflight.delete(req);
        reject(e instanceof Error ? e : new Error('ws send failed'));
      }
      return await promise;
    })();
  }

  async push(batch: LogEvent[]): Promise<PushAck> {
    const res = await this.request('push', { events: batch });
    if (res.op === 'error') throw new Error(`relay rejected push: ${res.message}`);
    if (res.op !== 'push_ack') throw new Error('relay protocol: expected push_ack');
    return { acked: res.acked, server_time: res.server_time };
  }

  async pull(since: number): Promise<{ events: LogEvent[]; cursor: number }> {
    const res = await this.request('pull', { since });
    if (res.op === 'error') throw new Error(`relay rejected pull: ${res.message}`);
    // Merge live hints the server history doesn't cover yet; UUID dedupe
    // keeps it exact (kernel also skips known UUIDs on apply).
    const seen = new Set(res.events.map((e) => e.id));
    const extra = this.liveBuf.filter((e) => !seen.has(e.id));
    this.liveBuf = this.liveBuf.filter((e) => !seen.has(e.id));
    return { events: [...res.events, ...extra], cursor: res.cursor };
  }

  close(): void {
    this.manualClose = true;
    this.onDrop(new Error('client closed'));
    try {
      this.ws?.close();
    } catch {
      /* gone */
    }
    this.ws = null;
    void this.manualClose;
  }
}
