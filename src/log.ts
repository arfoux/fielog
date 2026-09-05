// log.ts — JSONL append-only log: UUID per event, hash chain, fsync per append.
// Boring file: `tail -f kasir.log` friendly. One JSON object per line.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const GENESIS_HASH = 'GENESIS';

export interface LogEvent {
  id: string; // UUID, idempotency key across devices/relays
  seq: number; // local monotonic sequence, assigned on append
  type: string;
  actor?: string;
  device_id: string;
  ts_device: number; // wall clock, display only — NEVER authoritative
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  // Set only when learned from the relay / a peer; never hashed.
  origin_seq?: number;
  origin_device?: string;
  server_time?: number;
}

export interface AppendInput {
  type: string;
  payload?: Record<string, unknown>;
  actor?: string;
  device_id?: string;
  id?: string;
  ts_device?: number;
  // Preserved when re-importing a remote event locally.
  origin_seq?: number;
  origin_device?: string;
  server_time?: number;
}

/** Canonical bytes covered by the hash chain (server_time excluded on purpose). */
export function canonicalOf(e: Omit<LogEvent, 'hash'>): string {
  return JSON.stringify({
    id: e.id,
    seq: e.seq,
    type: e.type,
    actor: e.actor ?? null,
    device_id: e.device_id,
    ts_device: e.ts_device,
    payload: e.payload,
    prev_hash: e.prev_hash,
  });
}

export function hashFor(e: Omit<LogEvent, 'hash'>): string {
  return createHash('sha256').update(canonicalOf(e), 'utf8').digest('hex');
}

export interface AppendLog {
  path: string;
  append(input: AppendInput): LogEvent;
  readAll(): LogEvent[];
  readAfter(seq: number): LogEvent[];
  maxSeq(): number;
  lastHash(): string;
  verify(): { ok: boolean; at?: number; reason?: string };
  close(): void;
}

export function openLog(path: string, defaultDeviceId: string): AppendLog {
  const dir = dirname(path);
  if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
  let events: LogEvent[] = [];
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t) events.push(JSON.parse(t) as LogEvent);
    }
  }
  let nextSeq = events.length === 0 ? 1 : Math.max(...events.map((e) => e.seq)) + 1;
  let tip = events.length === 0 ? GENESIS_HASH : events[events.length - 1].hash;

  // Long-lived append fd so every write can be followed by fsync.
  const fd = openSync(path, 'a');

  return {
    path,
    append(input: AppendInput): LogEvent {
      if (!input.type || typeof input.type !== 'string') {
        throw new Error('log.append: type must be a non-empty string');
      }
      const core: Omit<LogEvent, 'hash'> = {
        id: input.id ?? randomUUID(),
        seq: nextSeq,
        type: input.type,
        actor: input.actor,
        device_id: input.device_id ?? defaultDeviceId,
        ts_device: input.ts_device ?? Date.now(),
        payload: input.payload ?? {},
        prev_hash: tip,
        origin_seq: input.origin_seq,
        origin_device: input.origin_device,
        server_time: input.server_time,
      };
      const ev: LogEvent = { ...core, hash: hashFor(core) };
      writeSync(fd, JSON.stringify(ev) + '\n');
      fsyncSync(fd); // durable before ack — offline means the disk is the server
      events.push(ev);
      nextSeq += 1;
      tip = ev.hash;
      return ev;
    },
    readAll(): LogEvent[] {
      return [...events];
    },
    readAfter(seq: number): LogEvent[] {
      return events.filter((e) => e.seq > seq);
    },
    maxSeq(): number {
      return nextSeq - 1;
    },
    lastHash(): string {
      return tip;
    },
    verify(): { ok: boolean; at?: number; reason?: string } {
      let prev = GENESIS_HASH;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.prev_hash !== prev) {
          return { ok: false, at: e.seq, reason: 'prev_hash mismatch (truncated/edited log?)' };
        }
        const { hash, ...core } = e;
        if (hashFor(core) !== hash) {
          return { ok: false, at: e.seq, reason: 'hash mismatch (tampered payload?)' };
        }
        prev = hash;
      }
      return { ok: true };
    },
    close(): void {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}
