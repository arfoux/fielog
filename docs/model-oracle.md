# model-oracle

Kalkulator model (~35 baris) + banding state vs implementasi tiap 100 langkah.
Port skill-6 MANTAP ke fielog: oracle aritmetika polos cermin routing
`route()` di `src/store.ts` (kasus `bayar` / `stock.add` / `stock.sell` /
`undo.compensate` saja), hasil banding diteriakkan dengan seed + step + op log.

## file

- `scripts/model-oracle.ts` — `Oracle` (~35 baris) + `checkOracle` (3 SELECT vs
  read-model: per-oleh live sums, stock qty, voided id set).
- `test/model-oracle.test.ts` — 1000 mixed ops seeded (`20260906`), cek tiap
  100 langkah + final converge; sibling deterministik ringan dari
  `test/model-fuzz.test.ts` (5000 langkah, oracle inline — hanya dibaca).
- `model-fuzz-report.md` — laporan fuzz asli (bukti angka 66/0, oracle 35 baris).

## mapping store.ts -> oracle

| store.ts `route()` | oracle |
|---|---|
| `bayar` insert + `resolvePendingUndos` (undo dulu -> void) | `bayar()`: `pend` -> `void`, else `pay[oleh] += n` |
| `stock.add` tambah qty + catat move | `add()`: `pend` -> `void`, else `stk[item] += q`, `mov[id]` |
| `stock.sell` oversell -> move voided + conflict, tanpa kurang stock | `sell()`: stock kurang -> `void`, else `stk[item] -= q`, `mov[id] = -q` |
| `undo.compensate` bayar -> void; move live -> void + balikan qty; unknown -> park `records` | `undo()`: bayar live -> kurangi `pay`, void; move live -> `stk -= signed`, void; unknown -> `pend` |
| target mendarat setelah undo park -> `resolvePendingUndos` void-kan | `bayar/add/sell` cek `pend` dulu — efek sama dari sisi oracle |

Sengaja di luar scope (seperti fuzz): transisi `payment.*` / settle —
op mix hanya bayar/undo/stock + kill-respawn/sync/replay.

## run

- `bun test test/model-oracle.test.ts`: 1 pass, 0 fail, 21.50s —
  oracle cocok kernel di semua 10 cek + final, divergensi nihil.
- full suite sesudah tambah file: 67 pass, 0 fail, 338.56s, 29 files
  (base 66/0 + 1 test baru) — divergensi nihil di semua cek oracle.

