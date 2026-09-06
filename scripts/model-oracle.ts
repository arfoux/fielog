// model-oracle: plain-arithmetic mirror of store.ts routing (bayar/stock/undo only).
// import from test/model-oracle.test.ts; canonical copy lives here, not inline.
export class Oracle {
  pay = new Map<string, number>(); // oleh -> live nominal sum
  nom = new Map<string, number>(); // bayar id -> nominal
  who = new Map<string, string>(); // bayar id -> oleh
  stk = new Map<string, number>(); // item -> qty on hand
  mov = new Map<string, { i: string; q: number }>(); // live stock move -> signed qty
  void = new Set<string>(); // voided bayar + stock ids (oversell parks included)
  pend = new Set<string>(); // undo targets not yet seen (records-parked)
  bayar(id: string, n: number, o: string): void {
    this.nom.set(id, n); this.who.set(id, o);
    if (this.pend.has(id)) { this.void.add(id); this.pend.delete(id); return; }
    this.pay.set(o, (this.pay.get(o) ?? 0) + n);
  }
  add(id: string, item: string, q: number): void {
    if (this.pend.has(id)) { this.pend.delete(id); this.void.add(id); return; }
    this.stk.set(item, (this.stk.get(item) ?? 0) + q);
    this.mov.set(id, { i: item, q });
  }
  sell(id: string, item: string, q: number): void {
    if ((this.stk.get(item) ?? 0) < q) { this.void.add(id); return; } // oversell park
    if (this.pend.has(id)) { this.pend.delete(id); this.void.add(id); return; }
    this.stk.set(item, (this.stk.get(item) ?? 0) - q);
    this.mov.set(id, { i: item, q: -q });
  }
  undo(t: string): void {
    if (this.nom.has(t) && !this.void.has(t)) {
      const o = this.who.get(t) as string;
      this.pay.set(o, (this.pay.get(o) ?? 0) - (this.nom.get(t) as number));
      this.void.add(t); return;
    }
    const m = this.mov.get(t);
    if (m) { this.stk.set(m.i, (this.stk.get(m.i) ?? 0) - m.q); this.mov.delete(t); this.void.add(t); return; }
    if (!this.nom.has(t) && !this.void.has(t)) this.pend.add(t); // unknown -> park
  }
}

// compare oracle state vs kernel read-model; throws with seed+step+op on mismatch.
export async function checkOracle(
  q: (sql: string) => Promise<Record<string, unknown>[]>,
  o: Oracle, ctx: string, tail: string,
): Promise<void> {
  const { default: assert } = await import('node:assert/strict');
  const payR = await q(`SELECT oleh, SUM(nominal) AS t FROM bayar WHERE voided = 0 GROUP BY oleh`);
  const pay = new Map(payR.map((r) => [String(r.oleh), Number(r.t)] as [string, number]));
  const stkR = await q(`SELECT item, qty FROM stock`);
  const stk = new Map(stkR.map((r) => [String(r.item), Number(r.qty)] as [string, number]));
  const voidR = await q(
    `SELECT event_id FROM bayar WHERE voided = 1 UNION ALL SELECT event_id FROM stock_moves WHERE voided = 1`);
  const norm = (m: Map<string, number>) =>
    new Map([...m].filter(([, v]) => v !== 0));
  const loud = (what: string, exp: unknown, got: unknown) =>
    `${ctx} MISMATCH ${what}\nexpected=${JSON.stringify(exp)}\nactual=${JSON.stringify(got)}\n--- last ops ---\n${tail}`;
  assert.deepEqual(norm(pay), norm(o.pay), loud('per-oleh balances', [...norm(o.pay)], [...norm(pay)]));
  assert.deepEqual(norm(stk), norm(o.stk), loud('stock balances', [...norm(o.stk)], [...norm(stk)]));
  assert.deepEqual(new Set(voidR.map((r) => String(r.event_id))), o.void,
    loud('voided ids', [...o.void].sort(), voidR.map((r) => String(r.event_id)).sort()));
}
