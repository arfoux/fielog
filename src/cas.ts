// cas.ts — skill-14 cas-store port (MANTAP) for fielog.
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
  mkdirSync,
  openSync,
  readFileSync,
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
      if (!existsSync(blob)) {
        mkdirSync(dirname(blob), { recursive: true });
        const fd = openSync(blob, 'wx');
        try {
          writeSync(fd, data);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
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
        renameSync(blob, casQuarantinePathFor(dir, key));
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
      if (!existsSync(blob)) return null;
      return { key, size: readFileSync(blob).length, refcount: n };
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
      persistManifest(dir, refs);
      return dead;
    },

    close(): void {
      persistManifest(dir, refs);
    },
  };
  return store;
}
