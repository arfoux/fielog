// fielog v0.1 — kernel skeleton. Worker owns full implementation.
// Contract: append/query/undo/sync per README. No network on append/query.
export type EventType = string;
export interface FielogEvent {
  id: string; // UUID
  seq?: number; // local monotonic, assigned on append
  type: EventType;
  ts_device?: number; // wall clock, display only, never authoritative
  actor?: string;
  payload: Record<string, unknown>;
}
export interface KernelOpts {
  file: string; // e.g. 'kasir.db' (+ sidecar '.log')
  relay?: string;
}
export async function createKernel(_opts: KernelOpts) {
  throw new Error('not implemented — worker task');
}
