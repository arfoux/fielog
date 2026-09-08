// revokelog.ts — authenticated revoke event-log, convergent across relays.
//
// Closes two relay-revocation leaks: (1) revokes were unauthenticated local
// state (relay.ts keeps a bare Set<string> plus a live 'revoked' hint any
// relay can claim), (2) that set never converges across relays (per-relay
// sidecar file, no merge). Here every revoke is an admin-signed event and
// replicas sync by idempotent set-union merge, so merge is commutative and
// snapshots converge.
//
// Event JSON: { v, tokenId, deviceId, epoch, admin, issuedAt, prev, hash, sig, id }
//   tokenId  revoked capability/grant id; '*' = whole-device revoke.
//   deviceId token owner whose capability dies.
//   epoch    monotonic per tokenId; higher supersedes lower.
//   admin    signer deviceId; must be in the trusted admin registry.
//   issuedAt wall clock, display only — never authoritative.
//   prev     hash-chain link: REVOKE_GENESIS or a known event hash (audit hint).
//   hash     sha256 over the canonical core; id = hash (idempotency key).
//   sig      admin ed25519 signature over hash (auth.ts signBytes).
import { createHash } from 'node:crypto';
import { signBytes, verifyBytes } from './auth.js';

export const REVOKE_GENESIS = 'REVOKE-GENESIS';
export const REVOKE_V = 1;

export interface RevokeEvent {
  v: 1;
  tokenId: string;
  deviceId: string;
  epoch: number;
  admin: string;
  issuedAt: number;
  prev: string;
  hash: string;
  sig: string;
  id: string;
}

export interface RevokeInput {
  tokenId: string;
  deviceId: string;
  epoch: number;
  issuedAt?: number;
}

export type AdminRegistry = Map<string, string> | Record<string, string>;

export function normalizeRegistry(reg?: AdminRegistry): Map<string, string> {
  if (!reg) return new Map();
  return reg instanceof Map ? new Map(reg) : new Map(Object.entries(reg));
}

type RevokeCore = Omit<RevokeEvent, 'hash' | 'sig' | 'id'>;

/** Canonical bytes covered by the chain hash (hash/sig/id excluded). */
export function canonicalRevoke(e: RevokeCore): string {
  return JSON.stringify({
    v: e.v,
    tokenId: e.tokenId,
    deviceId: e.deviceId,
    epoch: e.epoch,
    admin: e.admin,
    issuedAt: e.issuedAt,
    prev: e.prev,
  });
}

export function hashRevoke(e: RevokeCore): string {
  return createHash('sha256').update(canonicalRevoke(e), 'utf8').digest('hex');
}

function checkFields(e: RevokeCore): string | null {
  if (e.v !== REVOKE_V) return `unsupported v ${e.v as number}`;
  if (typeof e.tokenId !== 'string' || e.tokenId === '') return 'empty tokenId';
  if (typeof e.deviceId !== 'string' || e.deviceId === '') return 'empty deviceId';
  if (typeof e.admin !== 'string' || e.admin === '') return 'empty admin';
  if (!Number.isInteger(e.epoch) || e.epoch < 0) return `bad epoch ${e.epoch as number}`;
  if (typeof e.issuedAt !== 'number' || !Number.isFinite(e.issuedAt)) return 'bad issuedAt';
  if (typeof e.prev !== 'string' || e.prev === '') return 'empty prev';
  return null;
}

/** Build + admin-sign one revoke; prev threads the author's tip (audit hint). */
export function createRevokeEvent(
  adminPrivatePem: string,
  admin: string,
  input: RevokeInput,
  prev: string = REVOKE_GENESIS,
  now: number = Date.now(),
): RevokeEvent {
  const core: RevokeCore = {
    v: REVOKE_V,
    tokenId: input.tokenId,
    deviceId: input.deviceId,
    epoch: input.epoch,
    admin,
    issuedAt: input.issuedAt ?? now,
    prev,
  };
  const bad = checkFields(core);
  if (bad) throw new Error(`revoke rejected: ${bad}`);
  const hash = hashRevoke(core);
  return { ...core, hash, sig: signBytes(adminPrivatePem, hash), id: hash };
}

function verifyOne(admins: Map<string, string>, e: RevokeEvent): string | null {
  const bad = checkFields(e);
  if (bad) return bad;
  if (e.id !== e.hash) return 'id/hash split';
  const { hash, sig, id, ...core } = e;
  void id;
  if (hashRevoke(core) !== hash) return 'hash mismatch (tampered payload?)';
  const pub = admins.get(e.admin);
  if (!pub) return `unknown admin ${e.admin}`;
  if (!verifyBytes(pub, hash, sig)) return 'bad admin signature';
  return null;
}

/** Single-event auth check: content hash + known admin + signature. */
export function verifyRevokeEvent(admins: AdminRegistry, e: RevokeEvent): boolean {
  return verifyOne(normalizeRegistry(admins), e) === null;
}

export interface RevokeVerify {
  ok: boolean;
  at?: string;
  reason?: string;
}

/**
 * DAG replay over a batch: every event authentic and every non-genesis prev
 * pointing at a known hash. Order-free on purpose — concurrent writers fork
 * the prev hint, so this checks linkage, not a single linear order.
 */
export function verifyRevokeChain(admins: AdminRegistry, events: Iterable<RevokeEvent>): RevokeVerify {
  const reg = normalizeRegistry(admins);
  const list = [...events];
  for (const e of list) {
    const bad = verifyOne(reg, e);
    if (bad) return { ok: false, at: e.id, reason: bad };
  }
  const known = new Set(list.map((e) => e.hash));
  for (const e of list) {
    if (e.prev !== REVOKE_GENESIS && !known.has(e.prev)) {
      return { ok: false, at: e.id, reason: `dangling prev ${e.prev.slice(0, 12)}` };
    }
  }
  return { ok: true };
}

export interface MergeResult {
  added: number;
  skipped: number;
  rejected: number;
}

export type AppendOutcome = 'added' | 'duplicate';

export class RevokeLog {
  private admins: Map<string, string>;
  private order: RevokeEvent[] = []; // first-seen order; diffSince slices this
  private byHash = new Map<string, RevokeEvent>();

  constructor(trustedAdmins?: AdminRegistry) {
    this.admins = normalizeRegistry(trustedAdmins);
  }

  get size(): number {
    return this.order.length;
  }

  /** Live tip hash (REVOKE_GENESIS when empty); doubles as the next prev. */
  get tip(): string {
    return this.order.length > 0 ? this.order[this.order.length - 1].hash : REVOKE_GENESIS;
  }

  addAdmin(deviceId: string, publicKeyPem: string): void {
    this.admins.set(deviceId, publicKeyPem);
  }

  /** Sign + append in one step; prev threads the local tip. */
  create(adminPrivatePem: string, admin: string, input: RevokeInput, now: number = Date.now()): RevokeEvent {
    const e = createRevokeEvent(adminPrivatePem, admin, input, this.tip, now);
    this.append(e);
    return { ...e };
  }

  /** Verified single append; throws on forgery. Replay of a known hash is a no-op. */
  append(e: RevokeEvent): AppendOutcome {
    if (this.byHash.has(e.hash)) return 'duplicate';
    const bad = verifyOne(this.admins, e);
    if (bad) throw new Error(`revoke rejected: ${bad}`);
    if (e.prev !== REVOKE_GENESIS && !this.byHash.has(e.prev)) {
      throw new Error(`revoke rejected: dangling prev ${e.prev.slice(0, 12)}`);
    }
    const frozen = { ...e };
    this.order.push(frozen);
    this.byHash.set(frozen.hash, frozen);
    return 'added';
  }

  /**
   * Canonical convergent view: sorted by (epoch, hash). Byte-equal across
   * replicas after a full bidirectional merge, regardless of arrival order.
   */
  snapshot(): RevokeEvent[] {
    return [...this.order]
      .sort((a, b) => a.epoch - b.epoch || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
      .map((e) => ({ ...e }));
  }

  /**
   * First-seen suffix after cursor; cursor = order.length. Only diff your own
   * log (it is append-only, so the cursor is stable); cross-replica sync is
   * merge(snapshot) — set union needs no cursor.
   */
  diffSince(cursor: number): { events: RevokeEvent[]; cursor: number } {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.order.length) {
      throw new Error(`revoke rejected: bad cursor ${cursor as number}`);
    }
    return { events: this.order.slice(cursor).map((e) => ({ ...e })), cursor: this.order.length };
  }

  /**
   * Idempotent set-union merge: commutative, so A.merge(B) then B.merge(A)
   * converges. Unordered batches resolve to a fixpoint (prev may arrive
   * later in the same batch); forged or dangling events count as rejected
   * and are never stored.
   */
  merge(remote: Iterable<RevokeEvent>): MergeResult {
    const res: MergeResult = { added: 0, skipped: 0, rejected: 0 };
    const pending: RevokeEvent[] = [];
    for (const e of remote) {
      if (this.byHash.has(e.hash)) {
        res.skipped += 1;
        continue;
      }
      if (verifyOne(this.admins, e) !== null) {
        res.rejected += 1;
        continue;
      }
      pending.push(e);
    }
    let progress = true;
    while (progress && pending.length > 0) {
      progress = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const e = pending[i];
        if (e.prev === REVOKE_GENESIS || this.byHash.has(e.prev)) {
          pending.splice(i, 1);
          const frozen = { ...e };
          this.order.push(frozen);
          this.byHash.set(frozen.hash, frozen);
          res.added += 1;
          progress = true;
        }
      }
    }
    res.rejected += pending.length;
    return res;
  }

  verify(): RevokeVerify {
    return verifyRevokeChain(this.admins, this.order);
  }

  /** Effective state: revoked iff some event for tokenId has epoch >= tokenEpoch. */
  isRevoked(tokenId: string, tokenEpoch = 0): boolean {
    for (const e of this.order) {
      if (e.tokenId === tokenId && e.epoch >= tokenEpoch) return true;
    }
    return false;
  }

  /**
   * One row per tokenId at its max epoch, sorted by tokenId. Epoch ties
   * break by min event hash, mirroring snapshot()'s (epoch, hash) order,
   * so arrival order never decides the winner across replicas.
   */
  revokedTokens(): Array<{ tokenId: string; deviceId: string; epoch: number }> {
    const top = new Map<string, { tokenId: string; deviceId: string; epoch: number; hash: string }>();
    for (const e of this.order) {
      const cur = top.get(e.tokenId);
      if (!cur || e.epoch > cur.epoch || (e.epoch === cur.epoch && e.hash < cur.hash)) {
        top.set(e.tokenId, { tokenId: e.tokenId, deviceId: e.deviceId, epoch: e.epoch, hash: e.hash });
      }
    }
    return [...top.values()]
      .map(({ tokenId, deviceId, epoch }) => ({ tokenId, deviceId, epoch }))
      .sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
  }
}
