// quota.ts — skill-15 quota-guard port for fielog.
//
// Admission control over on-disk usage. A guard tracks a byte ceiling and a
// set of files whose size counts as usage; callers `reserve(n)` before
// growing state (append, snapshot, sync spool) and `release(n)` when the
// growth is dropped. Every decision re-measures the files, so growth behind
// the guard's back is caught, not trusted.
//
// Fail-closed: usage that cannot be measured denies admission. A stat
// failure other than "missing file" throws ERR_QUOTA_UNKNOWN and every
// admission check (`reserve`, `check`, `remaining`) propagates it — the
// guard never reports "space available" it cannot prove. Over-quota throws
// ERR_QUOTA_EXCEEDED carrying the measured numbers. Bad inputs throw
// ERR_QUOTA_INVALID. Standalone module: no kernel wiring (kernel keeps its
// own ERR_OUTBOX_FULL outbox cap in src/kernel.ts).
import { statSync } from 'node:fs';

export interface QuotaOpts {
  /** Hard ceiling in bytes; must be a positive integer. */
  limitBytes: number;
  /** Files whose on-disk size counts as usage. Missing files count 0. */
  files?: string[];
}

export interface QuotaStatus {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
}

export interface QuotaGuard {
  readonly limit: number;
  /** Measured on-disk bytes of `files`. Throws ERR_QUOTA_UNKNOWN when unmeasurable. */
  usage(): number;
  /** Bytes currently held via `reserve` and not yet released. */
  held(): number;
  /** `limit - used - held`. Throws ERR_QUOTA_UNKNOWN when unmeasurable. */
  remaining(): number;
  /** Hold `bytes`; throws ERR_QUOTA_EXCEEDED / ERR_QUOTA_UNKNOWN / ERR_QUOTA_INVALID. */
  reserve(bytes: number): void;
  /** Free `bytes` previously held; clamps at zero, never throws for over-release. */
  release(bytes: number): void;
  /** Throw ERR_QUOTA_EXCEEDED if measured + held exceeds the ceiling right now. */
  check(): void;
  /** Full snapshot; throws ERR_QUOTA_UNKNOWN when unmeasurable. */
  status(): QuotaStatus;
}

function invalid(what: string, got: unknown): Error {
  return new Error(`ERR_QUOTA_INVALID: ${what} must be a positive integer (got ${String(got)})`);
}

/** Sum file sizes. ENOENT = 0 (fresh path, provably empty); any other stat
 *  failure = ERR_QUOTA_UNKNOWN (fail-closed: unknown usage denies). */
function measure(files: string[]): number {
  let used = 0;
  for (const f of files) {
    try {
      used += statSync(f).size;
    } catch (e) {
      if (e !== null && typeof e === 'object' && (e as { code?: unknown }).code === 'ENOENT') continue;
      throw new Error(`ERR_QUOTA_UNKNOWN: cannot measure '${f}' (fail-closed, refusing admission)`);
    }
  }
  return used;
}

function checkBytes(bytes: number, what: string): void {
  if (!Number.isInteger(bytes) || bytes < 1) throw invalid(what, bytes);
}

export function openQuotaGuard(opts: QuotaOpts): QuotaGuard {
  if (!opts || !Number.isInteger(opts.limitBytes) || opts.limitBytes < 1) {
    throw invalid('limitBytes', opts?.limitBytes);
  }
  const limit = opts.limitBytes;
  const files = [...(opts.files ?? [])];
  let held = 0;

  const usage = (): number => measure(files);

  const deny = (used: number, want: number): Error =>
    new Error(
      `ERR_QUOTA_EXCEEDED: used ${used} + held ${held} + want ${want} exceeds limit ${limit}; ` +
        `release reservations or raise the ceiling before growing state`,
    );

  return {
    limit,
    usage,
    held: () => held,
    remaining: () => limit - usage() - held,
    reserve: (bytes: number): void => {
      checkBytes(bytes, 'reserve bytes');
      const used = usage(); // throws ERR_QUOTA_UNKNOWN: unmeasurable denies
      if (used + held + bytes > limit) throw deny(used, bytes);
      held += bytes;
    },
    release: (bytes: number): void => {
      checkBytes(bytes, 'release bytes');
      held = Math.max(0, held - bytes);
    },
    check: (): void => {
      const used = usage(); // throws ERR_QUOTA_UNKNOWN: unmeasurable denies
      if (used + held > limit) throw deny(used, 0);
    },
    status: (): QuotaStatus => {
      const used = usage();
      return { limit, used, reserved: held, remaining: limit - used - held };
    },
  };
}
