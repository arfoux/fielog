// cas.ts — skill-14 cas-store port (stable) for fielog.
//
// Content-addressed blob store: the sha256 of the bytes IS the key, so the
// same attachment stored twice costs one blob plus a refcount. Refs are
// explicit (put/link add one, unlink drops one); the blob dies at zero.
// Reads re-hash and quarantine on mismatch, mirroring hashchain.ts.
//
// Layout under <dir>:
//   sha/<ab>/<cdef...>  blob bytes, key = ab+cdef...
//   cas.json            { refs: { <key>: <count> } }, atomic rename per mutation
//   quarantine/<key>    blobs that failed re-hash on read (forensics, never served)
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/;

/** sha256 hex of the bytes. The key, no registry, no counter. */
export function casKeyFor(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Shard two hex chars deep so one directory never holds every blob. */
export function casShardFor(key: string): string {
  return key.slice(0, 2);
}

/** Blob path for a key under a cas dir. */
export function casPathFor(dir: string, key: string): string {
  return join(dir, 'sha', casShardFor(key), key.slice(2));
}

/** Forensic sidecar for blobs that failed re-hash on read. */
export function casQuarantinePathFor(dir: string, key: string): string {
  return join(dir, 'quarantine', key);
}

function manifestPathFor(dir: string): string {
  return join(dir, 'cas.json');
}

export interface CasStat {
  key: string;
  size: number;
  refcount: number;
}

export interface CasStore {
  readonly dir: string;
  /** Blobs quarantined for hash mismatch since open. */
  quarantined: number;
  /** Store bytes, add one ref. Same bytes twice = one blob, refcount 2. */
  put(data: Uint8Array | string): string;
  /** Blob bytes, or null when missing/unreadable/mismatched. Never throws on data. */
  get(key: string): Buffer | null;
  has(key: string): boolean;
  stat(key: string): CasStat | null;
  /** Add one ref to a stored key. Throws on unknown key (fail fast, no phantom refs). */
  link(key: string): void;
  /** Drop one ref; deletes the blob at zero. True when a blob died. */
  unlink(key: string): boolean;
  /** Sweep crash orphans: blobs with no ref entry, entries with no blob. Returns dead keys. */
  gc(): string[];
  close(): void;
}

function checkKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`bad cas key (want sha256 hex): ${key.slice(0, 32)}`);
}
/** Best-effort directory fsync so creates/renames survive a crash. Never throws. */
function fsyncDir(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Best effort: some platforms refuse dir fsync; durability hint only.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors on a durability hint.
      }
    }
  }
}

/** Atomic manifest persist: write tmp + fsync + rename, same cutover as retain.ts. */
function persistManifest(dir: string, refs: Record<string, number>): void {
  const path = manifestPathFor(dir);
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify({ refs }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/**
 * Open a cas store at `dir` (created when missing). The manifest loads once;
 * every ref mutation persists it atomically, so a kill between ops loses at
 * most nothing committed — refs never point at a half-written blob because
 * the blob is exclusively created BEFORE the manifest names it.
 */
export function openCas(dir: string): CasStore {
  mkdirSync(join(dir, 'sha'), { recursive: true });
  mkdirSync(join(dir, 'quarantine'), { recursive: true });
  let refs: Record<string, number> = {};
  const mpath = manifestPathFor(dir);
  if (existsSync(mpath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(mpath, 'utf8'));
    } catch {
      throw new Error('corrupt cas manifest (not json, refusing to guess refs)');
    }
    if (!parsed || typeof parsed !== 'object' || !('refs' in parsed) || typeof parsed.refs !== 'object' || parsed.refs === null) {
      throw new Error('corrupt cas manifest (no refs table, refusing to guess refs)');
    }
    for (const [k, v] of Object.entries(parsed.refs as Record<string, unknown>)) {
      if (!KEY_RE.test(k) || typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error('corrupt cas manifest (bad key or count, refusing to guess refs)');
      }
      if (v > 0) refs[k] = v;
    }
  } else {
    persistManifest(dir, refs);
  }

  const store: CasStore & { quarantined: number } = {
    dir,
    quarantined: 0,
    put(data: Uint8Array | string): string {
      const key = casKeyFor(data);
      const blob = casPathFor(dir, key);
      mkdirSync(dirname(blob), { recursive: true });
      for (let attempt = 0; ; attempt += 1) {
        try {
          const fd = openSync(blob, 'wx');
          try {
            if (typeof data === 'string') writeSync(fd, data);
            else writeSync(fd, data);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          fsyncDir(dirname(blob));
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          // Concurrent same-key winner already created the blob: adopt it.
          // Windows reports the loser as EPERM/EACCES/EBUSY when the winner
          // still holds the file, so those mean EEXIST when the blob exists.
          if (code === 'EEXIST') break;
          if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
            if (existsSync(blob)) break;
            if (attempt < 2) continue;
          }
          throw err;
        }
      }
      refs[key] = (refs[key] ?? 0) + 1;
      persistManifest(dir, refs);
      return key;
    },

    get(key: string): Buffer | null {
      if (!KEY_RE.test(key)) return null;
      if (!(key in refs)) return null;
      const blob = casPathFor(dir, key);
      if (!existsSync(blob)) return null;
      let bytes: Buffer;
      try {
        bytes = readFileSync(blob);
      } catch {
        return null;
      }
      if (casKeyFor(bytes) !== key) {
        const qpath = casQuarantinePathFor(dir, key);
        try {
          mkdirSync(dirname(qpath), { recursive: true });
          renameSync(blob, qpath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'EEXIST' || code === 'EPERM') {
            // A previous quarantine already occupies the sidecar (Windows
            // rename refuses to overwrite): drop the loser copy rather than
            // serving corrupt bytes or throwing on the data path.
            try {
              unlinkSync(qpath);
              renameSync(blob, qpath);
            } catch {
              try {
                unlinkSync(blob);
              } catch {
                // Blob already gone; refs cleanup below still applies.
              }
            }
          } else if (code !== 'ENOENT') {
            try {
              unlinkSync(blob);
            } catch {
              // Blob already gone; refs cleanup below still applies.
            }
          }
        }
        fsyncDir(dirname(blob));
        fsyncDir(dirname(qpath));
        delete refs[key];
        persistManifest(dir, refs);
        store.quarantined += 1;
        return null;
      }
      return bytes;
    },

    has(key: string): boolean {
      if (!KEY_RE.test(key)) return false;
      return key in refs && existsSync(casPathFor(dir, key));
    },

    stat(key: string): CasStat | null {
      if (!KEY_RE.test(key)) return null;
      const n = refs[key];
      if (n === undefined) return null;
      const blob = casPathFor(dir, key);
      let fd: number | undefined;
      try {
        fd = openSync(blob, 'r');
        const size = fstatSync(fd).size;
        return { key, size, refcount: n };
      } catch {
        // Blob missing or unreadable between the refs check and now.
        return null;
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // Ignore close errors on a read-only stat probe.
          }
        }
      }
    },

    link(key: string): void {
      checkKey(key);
      if (!(key in refs)) throw new Error('link of unknown cas key (put first, no phantom refs)');
      refs[key] += 1;
      persistManifest(dir, refs);
    },

    unlink(key: string): boolean {
      checkKey(key);
      const n = refs[key];
      if (n === undefined) throw new Error('unlink of unknown cas key (no phantom refs)');
      if (n <= 1) {
        delete refs[key];
        const blob = casPathFor(dir, key);
        if (existsSync(blob)) unlinkSync(blob);
        persistManifest(dir, refs);
        return true;
      }
      refs[key] = n - 1;
      persistManifest(dir, refs);
      return false;
    },

    gc(): string[] {
      const dead: string[] = [];
      for (const key of Object.keys(refs)) {
        if (!existsSync(casPathFor(dir, key))) {
          delete refs[key];
          dead.push(key);
        }
      }
      // Crash window: the blob was exclusively created but the manifest
      // never named it (kill between blob write and persist). Sweep blobs
      // with no ref entry so they never leak silently.
      let shards: string[] = [];
      try {
        shards = readdirSync(join(dir, 'sha'));
      } catch {
        shards = [];
      }
      for (const shard of shards) {
        let names: string[] = [];
        try {
          names = readdirSync(join(dir, 'sha', shard));
        } catch {
          continue;
        }
        for (const rest of names) {
          const key = shard + rest;
          if (!KEY_RE.test(key)) continue;
          if (key in refs) continue;
          try {
            unlinkSync(join(dir, 'sha', shard, rest));
          } catch {
            continue;
          }
          dead.push(key);
        }
      }
      persistManifest(dir, refs);
      return dead;
    },

    close(): void {
      persistManifest(dir, refs);
    },
  };
  return store;
}
