# model-fuzz report (money truth)

base proof: full suite green before the change (64 pass, 0 fail, 102s).
after: full suite green with fuzz added (66 pass, 0 fail, 198s).
fuzz alone: 2 pass, 0 fail, 112s (seed 20260906 + unseeded seed 365736147 / 1147118171).

scope: test/model-fuzz.test.ts. seeded mulberry32 rng drives 5000 mixed ops
per run, applied identically to kernel and oracle: append bayar, stock.add,
stock.sell, undo (10% unknown ids to exercise records-park path), sync
(random chunkSize), kill-respawn (ack cursor must survive), replay
(close+reopen, verifyLog clean). state compared every 100 steps plus a final
converged check: per-oleh live sums vs SELECT SUM(nominal) GROUP BY oleh,
stock qty per item vs SELECT itemqty FROM stock, full voided id set vs
bayar+stock_moves voided selects. any mismatch throws with seed + step + op
+ expected/actual + last 80 ops of the op log.

## oracle (35 lines, in full)

```ts
// oracle: plain-arithmetic mirror of store.ts routing (bayar/stock/undo only).
class Oracle {
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
```

## notes

- first attempt timed out at 120s per run: 16% kill/replay rate made reopen
  replay o(n^2). thinned to 1.5% kill + 1.5% replay; all op kinds retained.
- settle/payment transitions intentionally out of scope: op mix is
  bayar/undo/stock + kill-respawn/sync/replay per the task.
- nothing left: oracle+fuzz green, full suite green, committed.
