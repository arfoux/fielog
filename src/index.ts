// fielog v0.1 — offline-first kernel: append-only log + SQLite read-model + sync.
export { openLog, hashFor, canonicalOf, GENESIS_HASH } from './log.js';
export type { LogEvent, AppendInput, AppendLog, VerifyResult } from './log.js';
export { openStore, MoneyState, checkAppend } from './store.js';
export type { EventStore, MoneyState as MoneyStateType, SqlParams } from './store.js';
export { MemoryRelay, pushPending, pullRemote, syncKernel, withBackoff, backoffMs, getAckSeq, getServerTime } from './sync.js';
export type { Relay, PushAck, PushResult, PullResult, SyncOpts } from './sync.js';
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
} from './auth.js';
export type { DeviceKeypair, ScopeGrant, Countersignature } from './auth.js';
export { createKernel, logPathFor } from './kernel.js';
export type { Kernel, KernelOpts, AppendArgs, LogHealth } from './kernel.js';
export { WsRelayServer, WsRelayClient, mulberry32 } from './relay.js';
export type { WsRelayServerOpts, WsRelayClientOpts } from './relay.js';
