// log.ts — JSONL append-only log: UUID per event, hash chain, fsync per append.
// Boring file: `tail -f kasir.log` friendly. One JSON object per line.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
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

export interface VerifyResult {
  ok: boolean;
  at?: number;
  reason?: string;
  gaps?: number[]; // seqs re-anchored after a quarantined line (known gap, not tamper)
}

export interface AppendLog {
  path: string;
  append(input: AppendInput): LogEvent;
  readAll(): LogEvent[];
  readAfter(seq: number): LogEvent[];
  maxSeq(): number;
  lastHash(): string;
  verify(): VerifyResult;
  /** true when open truncated a torn tail write (kill mid-append). */
  repairedTail: boolean;
  /** mid-file lines skipped into <path>.quarantine. */
  quarantined: number;
  close(): void;
}

export function openLog(path: string, defaultDeviceId: string): AppendLog {
  const dir = dirname(path);
  if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
  const quarantinePath = path + '.quarantine';
  const seenQ = new Set<string>();
  if (existsSync(quarantinePath)) {
    for (const line of readFileSync(quarantinePath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed: unknown = JSON.parse(t);
        if (parsed && typeof parsed === 'object' && 'sha' in parsed && typeof parsed.sha === 'string') {
          seenQ.add(parsed.sha);
        }
      } catch {
        seenQ.add(createHash('sha256').update(t, 'utf8').digest('hex'));
      }
    }
  }
  const noteQuarantine = (lineNo: number, raw: string): void => {
    const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
    if (seenQ.has(sha)) return; // reopening must not duplicate forensics
    seenQ.add(sha);
    appendFileSync(quarantinePath, JSON.stringify({ line: lineNo, sha, raw }) + '\n');
  };
  let events: LogEvent[] = [];
  const gapBefore = new Set<number>(); // kept seqs following a skipped line
  let skipPending = false;
  let quarantined = 0;
  let repairedTail = false;
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const parts = raw.split('\n');
    // Offsets locate a torn tail for truncation; file ends with '\n' so the
    // last part is always ''.
    let off = 0;
    const starts: number[] = parts.map((p) => {
      const s = off;
      off += Buffer.byteLength(p, 'utf8') + 1;
      return s;
    });
    const lastIdx = parts.length - 2; // last non-empty line index
    for (let i = 0; i <= lastIdx; i++) {
      const t = parts[i].trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t) as LogEvent;
        if (skipPending) {
          gapBefore.add(ev.seq);
          skipPending = false;
        }
        events.push(ev);
      } catch {
        if (i === lastIdx) {
          // Torn tail: the write never completed, so no event was ever
          // durable — truncate it, keep a forensic copy, carry on.
          const f = openSync(path, 'r+');
          ftruncateSync(f, starts[i]);
          closeSync(f);
          noteQuarantine(i + 1, t + ' /* torn tail, truncated on open */');
          repairedTail = true;
        } else {
          noteQuarantine(i + 1, t);
          quarantined += 1;
          skipPending = true;
        }
      }
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
    verify(): VerifyResult {
      let prev = GENESIS_HASH;
      const gaps: number[] = [];
      for (const e of events) {
        const { hash, ...core } = e;
        if (hashFor(core) !== hash) {
          return { ok: false, at: e.seq, reason: 'hash mismatch (tampered payload?)' };
        }
        if (e.prev_hash !== prev) {
          if (!gapBefore.has(e.seq)) {
            return { ok: false, at: e.seq, reason: 'prev_hash mismatch (truncated/edited log?)' };
          }
          gaps.push(e.seq); // known gap: predecessor was quarantined, re-anchor
        }
        prev = hash;
      }
      return gaps.length > 0 ? { ok: true, gaps } : { ok: true };
    },
    repairedTail,
    quarantined,
    close(): void {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}
