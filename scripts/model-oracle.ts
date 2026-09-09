// model-oracle: plain-arithmetic mirror of store.ts routing (payment/stock/undo only).
// import from test/model-oracle.test.ts; canonical copy lives here, not inline.
export class Oracle {
  pay = new Map<string, number>(); // actor -> live amount sum
  amt = new Map<string, number>(); // payment id -> amount
  who = new Map<string, string>(); // payment id -> actor
  stk = new Map<string, number>(); // item -> qty on hand
  mov = new Map<string, { i: string; q: number }>(); // live stock move -> signed qty
  void = new Set<string>(); // voided payment + stock ids (oversell parks included)
  pend = new Set<string>(); // undo targets not yet seen (records-parked)
  payment(id: string, n: number, a: string): void {
    this.amt.set(id, n); this.who.set(id, a);
    if (this.pend.has(id)) { this.void.add(id); this.pend.delete(id); return; }
    this.pay.set(a, (this.pay.get(a) ?? 0) + n);
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
    if (this.amt.has(t) && !this.void.has(t)) {
      const a = this.who.get(t) as string;
      this.pay.set(a, (this.pay.get(a) ?? 0) - (this.amt.get(t) as number));
      this.void.add(t); return;
    }
    const m = this.mov.get(t);
    if (m) { this.stk.set(m.i, (this.stk.get(m.i) ?? 0) - m.q); this.mov.delete(t); this.void.add(t); return; }
    if (!this.amt.has(t) && !this.void.has(t)) this.pend.add(t); // unknown -> park
  }
}

// compare oracle state vs kernel read-model; throws with seed+step+op on mismatch.
export async function checkOracle(
  q: (sql: string) => Promise<Record<string, unknown>[]>,
  o: Oracle, ctx: string, tail: string,
): Promise<void> {
  const { default: assert } = await import('node:assert/strict');
  const payR = await q(`SELECT actor, SUM(amount) AS t FROM payment WHERE voided = 0 GROUP BY actor`);
  const pay = new Map(payR.map((r) => [String(r.actor), Number(r.t)] as [string, number]));
  const stkR = await q(`SELECT item, qty FROM stock`);
  const stk = new Map(stkR.map((r) => [String(r.item), Number(r.qty)] as [string, number]));
  const voidR = await q(
    `SELECT event_id FROM payment WHERE voided = 1 UNION ALL SELECT event_id FROM stock_moves WHERE voided = 1`);
  const norm = (m: Map<string, number>) =>
    new Map([...m].filter(([, v]) => v !== 0));
  const loud = (what: string, exp: unknown, got: unknown) =>
    `${ctx} MISMATCH ${what}\nexpected=${JSON.stringify(exp)}\nactual=${JSON.stringify(got)}\n--- last ops ---\n${tail}`;
  assert.deepEqual(norm(pay), norm(o.pay), loud('per-actor balances', [...norm(o.pay)], [...norm(pay)]));
  assert.deepEqual(norm(stk), norm(o.stk), loud('stock balances', [...norm(o.stk)], [...norm(stk)]));
  assert.deepEqual(new Set(voidR.map((r) => String(r.event_id))), o.void,
    loud('voided ids', [...o.void].sort(), voidR.map((r) => String(r.event_id)).sort()));
}
