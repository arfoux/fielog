// retain.ts — snapshot + truncate: bound the log without losing truth.
// Only the acked prefix (the relay already holds it) is ever swept, and the
// cutover is write-new-file + atomic rename, never in-place mutation.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { isMarker } from './log.js';
import type { EventStore } from './store.js';

export interface SnapshotResult {
  snapshot: string;
  sealedSeq: number; // acked prefix sealed into this snapshot
  dbSeq: number; // max event seq held by the db at snapshot time
}

export interface TruncateResult {
  removed: number;
  kept: number;
  sealedSeq: number;
}

export function snapshotPathFor(dbPath: string): string {
  return dbPath.replace(/\.(db|sqlite|sqlite3)$/, '') + '.snapshot.db';
}

/** Live db paths with a snapshot currently in flight. takeSnapshot is
 * synchronous, so a present key means re-entrant or overlapping use — fail
 * loud instead of interleaving two VACUUM INTO + stamp sequences over the
 * same live db (the second copy would stamp live meta out from under the
 * first, or vice versa). */
const snapshotsInFlight = new Set<string>();

/** Online full copy (VACUUM INTO) + seal stamp in both snapshot and live meta. */
export function takeSnapshot(
  store: EventStore,
  dbPath: string,
  sealedSeq: number,
  dest?: string,
): SnapshotResult {
  if (snapshotsInFlight.has(dbPath)) {
    throw new Error(
      `ERR_SNAPSHOT_IN_FLIGHT: snapshot already in progress for '${dbPath}'; ` +
        `finish it before starting another (overlapping copies would stamp live meta out of order)`,
    );
  }
  snapshotsInFlight.add(dbPath);
  try {
    const snapshot = dest ?? snapshotPathFor(dbPath);
    try {
      unlinkSync(snapshot); // VACUUM INTO refuses an existing target
    } catch {
      /* fresh path */
    }
    store.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    // Checkpoint BEFORE stamping: capture the observed read-model tip first,
    // so every stamp below describes the same state the copy was taken from.
    // A write landing between the copy and this read can only push dbSeq
    // above the copy — never below — so the seal stays conservative.
    const rows = store.query<{ m: number | null }>(`SELECT MAX(seq) AS m FROM _events`);
    const dbSeq: number = rows[0]?.m ?? 0;
    const db = new Database(snapshot);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(
          `INSERT INTO _meta(k,v) VALUES('snapshot.sealed_seq','${sealedSeq}') ` +
            `ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
        );
        db.exec(
          `INSERT INTO _meta(k,v) VALUES('snapshot.at','${Date.now()}') ` +
            `ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
        );
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already torn down — report the original failure */
        }
        throw err;
      }
    } finally {
      db.close();
    }
    // Both live stamps in one transaction: a crash must never leave
    // snapshot.path pointing at a copy whose seal differs from
    // snapshot.sealed_seq.
    store.exec('BEGIN IMMEDIATE');
    try {
      store.setMeta('snapshot.path', snapshot);
      store.setMeta('snapshot.sealed_seq', String(sealedSeq));
      store.exec('COMMIT');
    } catch (err) {
      try {
        store.exec('ROLLBACK');
      } catch {
        /* already torn down — report the original failure */
      }
      throw err;
    }
    return { snapshot, sealedSeq, dbSeq };
  } finally {
    snapshotsInFlight.delete(dbPath);
  }
}

/**
 * Clamp a snapshot seal to what truncate may safely sweep: at most the ack
 * cursor (never remove unacked data), and at most below the first swept seq
 * missing from the read-model (never remove unapplied data — a stale or
 * over-advanced ack must not turn into permanent loss). Returns 0 when
 * nothing is safely sweepable; the caller must treat that as a no-op.
 */
export function clampSealToStored(
  store: EventStore,
  logSeqs: number[],
  sealed: number,
  ackSeq: number,
): number {
  // An empty read-model proves nothing applied: seal/ack cursors alone must
  // never authorize a sweep, so report 0 (no-op) instead of min(sealed, ack).
  // Same when the log holds nothing at/below the seal — there is no proven
  // applied prefix to sweep.
  if (logSeqs.length === 0) return 0;
  let effective = Math.min(sealed, ackSeq);
  if (!(effective > 0)) return 0;
  const cands = logSeqs.filter((s) => s <= effective).sort((a, b) => a - b);
  if (cands.length === 0) return 0;
  const rows = store.query<{ seq: number }>(`SELECT seq FROM _events WHERE seq <= ?`, [effective]);
  const have = new Set(rows.map((r) => r.seq));
  for (const s of cands) {
    if (!have.has(s)) {
      effective = s - 1;
      break;
    }
  }
  return effective > 0 ? effective : 0;
}

/**
 * Sweep log lines with seq <= sealedSeq. New file = marker + kept lines,
 * fsynced, then atomically renamed over the original. The rename itself is
 * made durable with a directory fsync (`syncDir`, injectable for tests).
 * Only successfully parsed events at/below the seal are removed; markers
 * supersede, and anything unparseable is preserved byte-for-byte.
 */
export function sweepLogFile(
  logPath: string,
  sealedSeq: number,
  syncDir: (dir: string) => void = syncDirOf,
): TruncateResult {
  if (sealedSeq <= 0 || !existsSync(logPath)) return { removed: 0, kept: 0, sealedSeq: 0 };
  const kept: string[] = [];
  let removed = 0;
  let tip: string | null = null;
  let tipSeq = -1;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      kept.push(line); // corrupt bytes stay for quarantine on next open
      continue;
    }
    if (isMarker(parsed)) continue; // superseded by the new marker below
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'seq' in parsed &&
      typeof parsed.seq === 'number' &&
      'hash' in parsed &&
      typeof parsed.hash === 'string' &&
      parsed.seq <= sealedSeq
    ) {
      removed += 1;
      if (parsed.seq > tipSeq) {
        tipSeq = parsed.seq;
        tip = parsed.hash;
      }
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return { removed: 0, kept: kept.length, sealedSeq };
  const marker =
    JSON.stringify({
      v: 1,
      marker: 'fielog-truncate',
      truncated_before: sealedSeq + 1,
      tip,
      next_seq: sealedSeq + 1,
    }) + '\n';
  const tmp = logPath + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, marker);
    for (const l of kept) writeSync(fd, l + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, logPath);
  syncDir(dirname(logPath)); // make the rename itself durable before reporting success
  return { removed, kept: kept.length, sealedSeq };
}

/**
 * Best-effort directory fsync so a sweep rename survives a crash (the file
 * fsync above only durables content, not the directory entry). Platforms
 * without directory fsync fall through silently — content durability still
 * holds via the file fsync.
 */
function syncDirOf(dir: string): void {
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* no durable-rename primitive here */
  }
}
