// e2e-intents.ts — deterministic mixed-event generator shared by the full
// journey test and its SIGKILL crash child. Position-based, crash-safe:
// intents carry no event ids, so a killed-then-continued slice replays clean.
export type Intent =
  | { type: 'entry'; value: number; actor: string }
  | { type: 'tally.add'; payload: { item: string; qty: number }; actor: string }
  | { type: 'tally.remove'; payload: { item: string; qty: number }; actor: string };

const ACTORS = ['device-1', 'device-2', 'device-3'];

export function intentFor(i: number): Intent {
  const actor = ACTORS[i % ACTORS.length];
  if (i === 0) return { type: 'tally.add', payload: { item: 'kopi', qty: 2000 }, actor: 'gudang' };
  if (i === 1) return { type: 'tally.add', payload: { item: 'beras', qty: 2000 }, actor: 'gudang' };
  const m = i % 10;
  if (m <= 5) return { type: 'entry', value: 1000 + ((i * 37) % 9000), actor: actor };
  if (m === 6)
    return { type: 'tally.add', payload: { item: i % 20 === 6 ? 'kopi' : 'beras', qty: 20 }, actor };
  if (m === 7 || m === 8)
    return { type: 'tally.remove', payload: { item: i % 2 === 0 ? 'kopi' : 'beras', qty: 1 + (i % 4) }, actor };
  return { type: 'entry', value: 2000 + ((i * 53) % 5000), actor: actor };
}

// In-test mirror of the read-model for entry totals and tally levels.
// Removes never underflow by construction (seed 2000 + steady top-ups).
export interface Mirror {
  entryTotal: number;
  tally: Record<string, number>;
}

export function mirrorFor(range: [number, number]): Mirror {
  const m: Mirror = { entryTotal: 0, tally: {} };
  for (let i = range[0]; i < range[1]; i++) {
    const it = intentFor(i);
    if (it.type === 'entry') m.entryTotal += it.value;
    else if (it.type === 'tally.add') m.tally[it.payload.item] = (m.tally[it.payload.item] ?? 0) + it.payload.qty;
    else m.tally[it.payload.item] = (m.tally[it.payload.item] ?? 0) - it.payload.qty;
  }
  return m;
}
