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

/** Online full copy (VACUUM INTO) + seal stamp in both snapshot and live meta. */
export function takeSnapshot(
  store: EventStore,
  dbPath: string,
  sealedSeq: number,
  dest?: string,
): SnapshotResult {
  const snapshot = dest ?? snapshotPathFor(dbPath);
  try {
    unlinkSync(snapshot); // VACUUM INTO refuses an existing target
  } catch {
    /* fresh path */
  }
  store.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const db = new Database(snapshot);
  try {
    db.exec(
      `INSERT INTO _meta(k,v) VALUES('snapshot.sealed_seq','${sealedSeq}') ` +
        `ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
    );
    db.exec(
      `INSERT INTO _meta(k,v) VALUES('snapshot.at','${Date.now()}') ` +
        `ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
    );
  } finally {
    db.close();
  }
  store.setMeta('snapshot.path', snapshot);
  store.setMeta('snapshot.sealed_seq', String(sealedSeq));
  const rows = store.query<{ m: number | null }>(`SELECT MAX(seq) AS m FROM _events`);
  return { snapshot, sealedSeq, dbSeq: rows[0]?.m ?? 0 };
}

/**
 * Sweep log lines with seq <= sealedSeq. New file = marker + kept lines,
 * fsynced, then atomically renamed over the original. Only successfully
 * parsed events at/below the seal are removed; markers supersede, and
 * anything unparseable is preserved byte-for-byte (never drop blind).
 */
export function sweepLogFile(logPath: string, sealedSeq: number): TruncateResult {
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
  return { removed, kept: kept.length, sealedSeq };
}
