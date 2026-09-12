// hashchain.ts — skill-12 hash-chain-log port (stable) for fielog.
//
// Append + verify + quarantine + re-anchor facade over log.ts. The chain
// itself lives in log.ts (canonicalOf/hashFor/openLog); this module names
// the four operations as one boring surface so callers never reimplement
// chain checks by hand.
//
//   append     -> openHashChain(path, device).append(...) chains prev_hash
//   verify     -> chain.verify() replays hash + prev linkage
//   quarantine -> on open, unparsable mid-file lines move to <path>.quarantine
//   re-anchor  -> the first kept event after a gap verifies OK with gaps=[seq]
import {
  GENESIS_HASH,
  canonicalOf,
  hashFor,
  openLog,
  type AppendInput,
  type AppendLog,
  type LogEvent,
  type VerifyResult,
} from './log.js';

export { GENESIS_HASH, canonicalOf, hashFor };
export type { LogEvent, AppendInput, VerifyResult };

/** Forensic sidecar for quarantined lines. */
export function quarantinePathFor(path: string): string {
  return path + '.quarantine';
}

export interface HashChain extends AppendLog {}

/**
 * Pure chain replay over already-loaded events.
 *
 * Checks hash + prev linkage AND seq continuity (mirroring
 * AppendLog.verify()): only a forward jump onto a quarantined `gaps` seq
 * is forgiven (re-anchored). The chain is anchored at the first event's
 * seq, so a bare post-sweep suffix verifies — pass `opts.base` (marker tip)
 * and `opts.startSeq` (marker truncated_before) to pin the expected base
 * instead. Without them a foreign `prev_hash` on the first event fails
 * with a hint to use `log.verify()` (which knows the truncate marker);
 * post-sweep callers should prefer `openHashChain(path).verify()`.
 */
export function verifyChain(
  events: LogEvent[],
  gaps: Iterable<number> = [],
  opts: { base?: string; startSeq?: number } = {},
): VerifyResult {
  const gapSet = new Set(gaps);
  const echoed: number[] = [];
  let prev = opts.base ?? GENESIS_HASH;
  let expectedSeq = opts.startSeq ?? events[0]?.seq ?? 1;
  for (const e of events) {
    const { hash, signature: _s, countersignatures: _c, ...core } = e;
    void _s;
    void _c;
    if (hashFor(core) !== hash) {
      return { ok: false, at: e.seq, reason: 'hash mismatch (tampered payload?)' };
    }
    const seqForgiven = e.seq > expectedSeq && gapSet.has(e.seq);
    if (e.seq !== expectedSeq && !seqForgiven) {
      return {
        ok: false,
        at: e.seq,
        reason:
          e.seq < expectedSeq
            ? 'duplicate seq (forked/edited log?)'
            : e.seq === events[0]?.seq && e.prev_hash !== prev && opts.base === undefined
              ? 'prev_hash mismatch (swept prefix? pass opts.base/startSeq or use log.verify())'
              : 'seq gap (truncated/edited log?)',
      };
    }
    if (e.prev_hash !== prev) {
      if (!gapSet.has(e.seq)) {
        return {
          ok: false,
          at: e.seq,
          reason:
            e.seq === events[0]?.seq && opts.base === undefined
              ? 'prev_hash mismatch (swept prefix? pass opts.base/startSeq or use log.verify())'
              : 'prev_hash mismatch (truncated/edited log?)',
        };
      }
      echoed.push(e.seq);
    } else if (seqForgiven) {
      echoed.push(e.seq);
    }
    prev = hash;
    expectedSeq = e.seq + 1;
  }
  return echoed.length > 0 ? { ok: true, gaps: echoed } : { ok: true };
}

/**
 * Open a hash-chained log at `path`. Append chains prev_hash to the tip and
 * fsyncs per write; open quarantines corrupt mid-file lines and re-anchors
 * the survivor (see AppendLog.verify/quarantined/repairedTail/sealedBelow).
 */
export function openHashChain(
  path: string,
  deviceId: string,
  signer?: (ev: LogEvent) => string,
): HashChain {
  return openLog(path, deviceId, signer);
}
