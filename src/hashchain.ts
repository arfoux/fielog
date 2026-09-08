// hashchain.ts — skill-12 hash-chain-log port (MANTAP) for fielog.
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
 * `gaps` lists seqs whose predecessor was quarantined (known gap, not
 * tamper): their prev_hash is forgiven and echoed back, mirroring
 * AppendLog.verify(). Empty gaps = strict contiguous chain from GENESIS.
 */
export function verifyChain(events: LogEvent[], gaps: Iterable<number> = []): VerifyResult {
  const gapSet = new Set(gaps);
  const echoed: number[] = [];
  let prev = GENESIS_HASH;
  for (const e of events) {
    const { hash, signature: _s, countersignatures: _c, ...core } = e;
    void _s;
    void _c;
    if (hashFor(core) !== hash) {
      return { ok: false, at: e.seq, reason: 'hash mismatch (tampered payload?)' };
    }
    if (e.prev_hash !== prev) {
      if (!gapSet.has(e.seq)) {
        return { ok: false, at: e.seq, reason: 'prev_hash mismatch (truncated/edited log?)' };
      }
      echoed.push(e.seq); // re-anchor: known gap, chain resumes here
    }
    prev = hash;
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
