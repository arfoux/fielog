// bench/util.ts — shared helpers for fielog benchmarks (bun only).
export function parseN(argv: string[], def: number): number {
  const raw = argv[2] ?? String(def);
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`N must be a positive integer, got ${raw}`);
  return n;
}

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(samples: number[]): { p50: number; p99: number; n: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), p99: pct(sorted, 99), n: samples.length };
}
