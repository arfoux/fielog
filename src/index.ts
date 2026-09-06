// fielog v0.1 — offline-first kernel: append-only log + SQLite read-model + sync.
export { openLog, hashFor, canonicalOf, GENESIS_HASH } from './log.js';
export type { LogEvent, AppendInput, AppendLog, VerifyResult } from './log.js';
export { openHashChain, verifyChain, quarantinePathFor } from './hashchain.js';
export type { HashChain } from './hashchain.js';
export { openStore, MoneyState, checkAppend } from './store.js';
export type { EventStore, MoneyState as MoneyStateType, SqlParams } from './store.js';
export { MemoryRelay, pushPending, pullRemote, syncKernel, syncWithFailover, createFailoverState, withBackoff, backoffMs, getAckSeq, getServerTime } from './sync.js';
export type { Relay, PushAck, PushResult, PullResult, SyncOpts, FailoverState, FailoverResult } from './sync.js';
export { buildManifest, computeWant, createMemoryPeer, syncDelta } from './deltasync.js';
export type { DeltaManifest, DeltaPeer, DeltaOpts, DeltaResult } from './deltasync.js';
export {
  generateDeviceKey,
  signBytes,
  verifyBytes,
  signEvent,
  verifyEvent,
  issueGrant,
  verifyGrant,
  RevocationList,
  countersignEvent,
  checkThreshold,
  mintCapToken,
  verifyCapToken,
  canonicalCapToken,
} from './auth.js';
export type { DeviceKeypair, ScopeGrant, Countersignature, CapToken } from './auth.js';
export { createKernel, logPathFor, DEFAULT_OUTBOX_CAP } from './kernel.js';
export type { Kernel, KernelOpts, AppendArgs, LogHealth } from './kernel.js';
export { WsRelayServer, WsRelayClient, mulberry32 } from './relay.js';
export type { WsRelayServerOpts, WsRelayClientOpts } from './relay.js';
export { takeSnapshot, sweepLogFile, snapshotPathFor } from './retain.js';
export type { SnapshotResult, TruncateResult } from './retain.js';
export { openCas, casKeyFor, casShardFor, casPathFor, casQuarantinePathFor } from './cas.js';
export type { CasStore, CasStat } from './cas.js';
