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
import { RevokeLog, type RevokeEvent, type RevokeInput } from './revokelog.js';

export interface WsRelayServerOpts {
  port?: number; // 0 = ephemeral (read back via .port)
  file?: string; // JSONL persistence; reloaded on boot
  hbMs?: number; // server ping interval
  dropRate?: number; // chaos 0..1: fraction of inbound msgs dropped (deterministic)
  seed?: number; // chaos rng seed
  /** Pre-trusted devices: deviceId -> ed25519 publicKeyPem. Enforcement is on when non-empty. */
  trustedDevices?: Record<string, string>;
  /** Admin registry for the convergent revoke log (deviceId -> ed25519 publicKeyPem). */
  revokeAdmins?: Record<string, string>;
  /** Refuse to serve without a device registry (default true = legacy open
   * relay for library/dev use). The CLI passes false unless --unsigned. */
  allowUnsigned?: boolean;
}

type ToServer =
  | { op: 'push'; req: number; events: LogEvent[]; token?: CapToken }
  | { op: 'pull'; req: number; since: number; token?: CapToken }
  | { op: 'revoke_pull'; req: number; cursor: number }
  | { op: 'revoke_push'; req: number; events: RevokeEvent[] }
  | { op: 'pong' };

type ToClient =
  | { op: 'push_ack'; req: number; acked: string[]; server_time: number }
  | { op: 'pull_res'; req: number; events: LogEvent[]; cursor: number }
  | { op: 'revoke_res'; req: number; events: RevokeEvent[]; cursor: number }
  | { op: 'revoke_ack'; req: number; added: number; skipped: number; rejected: number; cursor: number }
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
  private devices = new Map<string, string>(); // deviceId -> publicKeyPem
  private revoked = new Set<string>(); // deviceIds; tombstones broadcast + persisted
  /** Convergent authenticated revoke log (revokelog.ts); empty when no admin configured. */
  readonly revokes = new RevokeLog();
  private revokedDevices = new Set<string>(); // device-tombstone cache, valid while revokes.size is stable
  private revokedDevicesAt = -1;
  serverTime = 1_700_000_000_000;
  pushesReceived = 0;
  pullsReceived = 0;
  pongsReceived = 0;
  rejectsReceived = 0;
  revokePullsReceived = 0;
  revokePushesReceived = 0;
  revokeRejected = 0; // forged/dangling revoke events refused over the wire, never stored
  crashAfter: number | null = null;
  private rng: () => number;
  constructor(private opts: WsRelayServerOpts = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    if (opts.trustedDevices) {
      for (const [id, pem] of Object.entries(opts.trustedDevices)) this.devices.set(id, pem);
    }
    if (opts.revokeAdmins) {
      for (const [id, pem] of Object.entries(opts.revokeAdmins)) this.revokes.addAdmin(id, pem);
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
    this.loadRevokeLog();
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

  /** Trust a revoke admin (same registry the handshake peers share). */
  addRevokeAdmin(deviceId: string, publicKeyPem: string): void {
    this.revokes.addAdmin(deviceId, publicKeyPem);
  }

  /** JSONL next to the event log; one signed RevokeEvent per line, never mixed into event lines. */
  private revokeLogFile(): string | null {
    return this.opts.file ? this.opts.file + '.revoke-events' : null;
  }

  private loadRevokeLog(): void {
    const f = this.revokeLogFile();
    if (!f || !existsSync(f)) return;
    const batch: RevokeEvent[] = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        batch.push(JSON.parse(t) as RevokeEvent);
      } catch {
        /* corrupt revoke line: not an event, skip on reload */
      }
    }
    // Idempotent set-union: forged or dangling lines are counted as rejected, never stored.
    this.revokeRejected += this.revokes.merge(batch).rejected;
  }

  private persistRevokes(fresh: RevokeEvent[]): void {
    const f = this.revokeLogFile();
    if (!f || fresh.length === 0) return;
    const dir = dirname(f);
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
    const fd = openSync(f, 'a');
    try {
      writeSync(fd, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fsyncSync(fd); // durable before any ack: restart loses nothing
    } finally {
      closeSync(fd);
    }
  }

  /** Admin-signed revoke into the convergent log (persists + converges via handshake). */
  issueRevoke(adminPrivatePem: string, admin: string, input: RevokeInput, now: number = Date.now()): RevokeEvent {
    const e = this.revokes.create(adminPrivatePem, admin, input, now);
    this.persistRevokes([e]);
    return e;
  }

  /** Canonical convergent view, byte-equal across replicas after full merge. */
  revokeSnapshot(): RevokeEvent[] {
    return this.revokes.snapshot();
  }

  /** Local revoke-log length; doubles as the next diffSince cursor. */
  revokeCursor(): number {
    return this.revokes.size;
  }

  /** Whole-device tombstone derived from the log: some '*' event names this device. */
  isDeviceRevokedByLog(deviceId: string): boolean {
    for (const e of this.revokes.snapshot()) {
      if (e.tokenId === '*' && e.deviceId === deviceId) return true;
    }
    return false;
  }

  /** Per-token kill: some event for tokenId carries an equal-or-higher epoch. */
  isTokenRevoked(tokenId: string, tokenEpoch = 0): boolean {
    return this.revokes.isRevoked(tokenId, tokenEpoch);
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
    return this.revoked.has(deviceId) || this.isDeviceRevokedByLog(deviceId);
  }

  revokedIds(): string[] {
    const ids = new Set<string>(this.revoked);
    for (const e of this.revokes.snapshot()) {
      if (e.tokenId === '*') ids.add(e.deviceId);
    }
    return [...ids].sort();
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
    // Double-start guard: a second serve would orphan the first listener and
    // leak its log fd (kill() only tracks the latest). Start once; kill, then
    // start again for a deliberate restart.
    if (this.server) throw new Error('relay already started');
    // Fail closed: an unsigned relay accepts any forged device_id, so
    // production entrypoints must register a device or opt into --unsigned.
    if (!this.enforcing && this.opts.allowUnsigned === false) {
      throw new Error('relay refuses unsigned mode: register a trusted device or pass --unsigned to opt into the open relay');
    }
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
    // Fail closed: a configured log with no open fd must never be acked as
    // durable. Throw so the push path answers error instead of push_ack.
    if (this.logFd === null) throw new Error('relay persist unavailable: event log not open, refusing to ack unwritten events');
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
    // Revoke handshake bypasses the capability gate and the chaos drop: the
    // events are self-authenticating (admin ed25519 over the content hash),
    // idempotent by hash, and a revoked device must still learn its own
    // revocation on reconnect. Forgeries are counted as rejected, never stored.
    if (msg.op === 'revoke_pull') {
      this.revokePullsReceived += 1;
      let out: { events: RevokeEvent[]; cursor: number };
      try {
        out = this.revokes.diffSince(msg.cursor);
      } catch {
        this.send(ws, { op: 'error', req: msg.req, code: 'bad_cursor', message: `revoke rejected: bad cursor ${msg.cursor}` });
        return;
      }
      this.send(ws, { op: 'revoke_res', req: msg.req, events: out.events, cursor: out.cursor });
      return;
    }
    if (msg.op === 'revoke_push') {
      this.revokePushesReceived += 1;
      const batch = Array.isArray(msg.events) ? msg.events : [];
      // No snapshot sorts here: merge only appends, so the pre-merge size is
      // the exact cursor of the fresh suffix — diffSince slices it for free.
      const cursorBefore = this.revokes.size;
      const res = this.revokes.merge(batch);
      this.revokeRejected += res.rejected;
      this.persistRevokes(this.revokes.diffSince(cursorBefore).events);
      this.send(ws, { op: 'revoke_ack', req: msg.req, added: res.added, skipped: res.skipped, rejected: res.rejected, cursor: this.revokes.size });
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
      if (msg.op === 'push' && Array.isArray(msg.events)) {
        try {
          this.store(msg.events);
        } catch {
          /* persist failed: stay unacked, the socket dies below, client resumes */
        }
      }
      try {
        ws.close();
      } catch {
        /* gone */
      }
      return;
    }
    if (msg.op === 'push') {
      this.pushesReceived += 1;
      if (!Array.isArray(msg.events)) {
        this.send(ws, { op: 'error', req: msg.req, code: 'bad_batch', message: 'relay rejected push: events must be an array' });
        return;
      }
      let fresh: LogEvent[];
      try {
        fresh = this.store(msg.events);
      } catch (err) {
        // Persist failed (e.g. log fd gone): nothing below is durable, so
        // answer error instead of acking unwritten events. The client keeps
        // the batch unacked and resumes it elsewhere.
        this.send(ws, { op: 'error', req: msg.req, code: 'persist', message: `relay rejected push: ${err instanceof Error ? err.message : 'persist failed'}` });
        return;
      }
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
      // Ack only ids confirmed stored (fresh or already-known duplicates):
      // never blind-echo the inbound batch, so intra-batch repeats collapse
      // to one ack and unwritten ids are never acked.
      const acked = [...new Set(msg.events.map((e) => e.id).filter((id) => this.byId.has(id)))];
      this.send(ws, { op: 'push_ack', req: msg.req, acked, server_time: this.serverTime });
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
    if (this.revokes.size > 0) {
      // Device-tombstone set cached while the revoke log length is stable:
      // one sort per mutation, not one per gated message. (Empty log needs
      // no sort at all — nothing can match.)
      if (this.revokedDevicesAt !== this.revokes.size) {
        const ids = new Set<string>();
        for (const e of this.revokes.snapshot()) {
          if (e.tokenId === '*') ids.add(e.deviceId);
        }
        this.revokedDevices = ids;
        this.revokedDevicesAt = this.revokes.size;
      }
      if (this.revokedDevices.has(token.deviceId)) {
        return fail(`device revoked: ${token.deviceId}`);
      }
    }
    if (token.id && this.revokes.isRevoked(token.id)) return fail(`token revoked: ${token.id}`);
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
    try {
      this.persist(fresh); // write-ahead: durable before any ack
    } catch (err) {
      // Persist failed: roll back the in-memory index so nothing looks
      // stored. The push path answers error (never acks), and the client's
      // retry lands here as fresh again.
      for (const ev of fresh) this.byId.delete(ev.id);
      this.order.splice(this.order.length - fresh.length, fresh.length);
      throw err;
    }
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
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* gone — same best-effort policy as broadcast: never let a dead socket
         take down the message loop with an uncaught throw */
    }
  }
}

export interface WsRelayClientOpts {
  baseMs?: number;
  maxMs?: number;
  maxRetries?: number; // reconnect attempts per call
  reqTimeoutMs?: number;
  capToken?: CapToken; // capability token attached to every push/pull
  /** Admin registry for the convergent revoke log (deviceId -> ed25519 publicKeyPem). */
  revokeAdmins?: Record<string, string>;
}

interface Inflight {
  resolve: (m: ToClient) => void;
  reject: (e: Error) => void;
  timer: Timer;
}
/** Cap on buffered live-broadcast hints per client. Pull is the source of
 * truth; hints must not grow without bound when the client never pulls. */
export const MAX_LIVE_HINTS = 1000;

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
  /** Convergent authenticated revoke log; syncs with the relay on every pull/push. */
  readonly revokes = new RevokeLog();
  private revokeServerCursor = 0; // relay log prefix already merged locally
  private revokeUpTo = 0; // local log prefix already offered to the relay
  revokeSyncs = 0;
  revokeRejected = 0; // forged/dangling events refused by either side, never stored

  constructor(
    private url: string,
    private opts: WsRelayClientOpts = {},
  ) {
    this.capToken = opts.capToken;
    if (opts.revokeAdmins) {
      for (const [id, pem] of Object.entries(opts.revokeAdmins)) this.revokes.addAdmin(id, pem);
    }
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
      // Bound the hint buffer: oldest hints drop first, pull stays the source
      // of truth so nothing is lost — the next pull re-covers the gap.
      if (this.liveBuf.length > MAX_LIVE_HINTS) {
        this.liveBuf.splice(0, this.liveBuf.length - MAX_LIVE_HINTS);
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

  private request(op: 'push' | 'pull' | 'revoke_pull' | 'revoke_push', body: Record<string, unknown>): Promise<ToClient> {
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
      // Revoke ops carry no capability token: the events authenticate
      // themselves via the admin signature, and a revoked device must still
      // complete the handshake to learn its own revocation.
      const auth = op === 'push' || op === 'pull' ? { ...(this.capToken ? { token: this.capToken } : {}) } : {};
      try {
        ws.send(JSON.stringify({ op, req, ...auth, ...body }));
      } catch (e) {
        clearTimeout(timer);
        this.inflight.delete(req);
        reject(e instanceof Error ? e : new Error('ws send failed'));
      }
      return await promise;
    })();
  }

  /** Trust a revoke admin (same registry the relay and peers share). */
  addRevokeAdmin(deviceId: string, publicKeyPem: string): void {
    this.revokes.addAdmin(deviceId, publicKeyPem);
  }

  /** Canonical convergent view, byte-equal with the relay after a full handshake. */
  revokeSnapshot(): RevokeEvent[] {
    return this.revokes.snapshot();
  }

  isTokenRevoked(tokenId: string, tokenEpoch = 0): boolean {
    return this.revokes.isRevoked(tokenId, tokenEpoch);
  }

  isDeviceRevoked(deviceId: string): boolean {
    if (this.revokedNotices.includes(deviceId)) return true;
    for (const e of this.revokes.snapshot()) {
      if (e.tokenId === '*' && e.deviceId === deviceId) return true;
    }
    return false;
  }

  /** Raw tail fetch; throws on protocol error (bad cursor included). */
  async pullRevokes(cursor: number): Promise<{ events: RevokeEvent[]; cursor: number }> {
    const res = await this.request('revoke_pull', { cursor });
    if (res.op === 'error') throw new Error(`relay rejected revoke_pull: ${res.message}`);
    if (res.op !== 'revoke_res') throw new Error('relay protocol: expected revoke_res');
    return { events: res.events, cursor: res.cursor };
  }

  /** Raw tail offer; forgeries count as rejected, never stored. */
  async pushRevokes(events: RevokeEvent[]): Promise<{ added: number; skipped: number; rejected: number; cursor: number }> {
    const res = await this.request('revoke_push', { events });
    if (res.op === 'error') throw new Error(`relay rejected revoke_push: ${res.message}`);
    if (res.op !== 'revoke_ack') throw new Error('relay protocol: expected revoke_ack');
    return { added: res.added, skipped: res.skipped, rejected: res.rejected, cursor: res.cursor };
  }

  /**
   * Bidirectional revoke handshake: pull the relay tail since the last known
   * server cursor and merge idempotently, offer the unseen local tail, then
   * pull once more so concurrent relay writes converge in a single call.
   * A stale cursor (relay restarted from an older file) falls back to a full
   * snapshot merge; set-union is idempotent so replay is always safe.
   */
  async syncRevokes(): Promise<{ added: number; skipped: number; rejected: number; serverCursor: number }> {
    const total = { added: 0, skipped: 0, rejected: 0 };
    // Snapshot the locally-authored tail BEFORE absorbing: anything merged
    // from the server below is already stored on the relay, and offering it
    // back would echo a perpetual tail (every handshake re-pushes the events
    // the previous handshake absorbed).
    const tail = this.revokes.diffSince(this.revokeUpTo).events;
    const absorb = async (): Promise<void> => {
      let res: { events: RevokeEvent[]; cursor: number };
      try {
        res = await this.pullRevokes(this.revokeServerCursor);
      } catch (err) {
        if (!(err instanceof Error) || !/bad cursor|bad_cursor/.test(err.message)) throw err;
        this.revokeServerCursor = 0;
        res = await this.pullRevokes(0);
      }
      const m = this.revokes.merge(res.events);
      total.added += m.added;
      total.skipped += m.skipped;
      total.rejected += m.rejected;
      this.revokeServerCursor = res.cursor;
    };
    await absorb();
    const ack = await this.pushRevokes(tail);
    total.added += ack.added;
    total.skipped += ack.skipped;
    total.rejected += ack.rejected;
    this.revokeUpTo = this.revokes.size;
    await absorb();
    // The second absorb only merges server-originated events the relay
    // already stores — mark them offered so the next handshake is quiet.
    this.revokeUpTo = this.revokes.size;
    this.revokeSyncs += 1;
    this.revokeRejected += total.rejected;
    return { ...total, serverCursor: this.revokeServerCursor };
  }

  /** Best-effort handshake around data ops: revoke state is a hint, the data pull stays the source of truth. */
  private async maybeSyncRevokes(): Promise<void> {
    try {
      await this.syncRevokes();
    } catch {
      /* next connect/pull retries idempotently */
    }
  }

  async push(batch: LogEvent[]): Promise<PushAck> {
    await this.maybeSyncRevokes();
    const res = await this.request('push', { events: batch });
    if (res.op === 'error') throw new Error(`relay rejected push: ${res.message}`);
    if (res.op !== 'push_ack') throw new Error('relay protocol: expected push_ack');
    return { acked: res.acked, server_time: res.server_time };
  }

  async pull(since: number): Promise<{ events: LogEvent[]; cursor: number }> {
    await this.maybeSyncRevokes();
    const res = await this.request('pull', { since });
    if (res.op === 'error') throw new Error(`relay rejected pull: ${res.message}`);
    if (res.op !== 'pull_res') throw new Error('relay protocol: expected pull_res');
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
