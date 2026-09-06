# corruption-generator

Port skill-9 (`corruption-generator`, status sehat) ke fielog: lib
deterministik untuk menyuntik satu fault per run ke jsonl log, plus test
detektor yang membuktikan tiap fault tertangkap saat reopen.

## file

- `scripts/corrupt-gen.ts` — `bitflip(path, lineNo)` + `tornTail(path)` +
  `truncateTail(path, dropLast)`; throw di luar range, tanpa random.
- `test/corrupt-gen.test.ts` — 3 test detektor via `health()` /
  `verifyLog()`; sibling deterministik dari `test/corrupt.test.ts`
  (satu fault handmade, hanya dibaca) dan `test/kill9.test.ts`
  (sigkill asli, hanya dibaca).
- `test/corrupt.test.ts` — pola acuan: bitrot mid-file -> `quarantined 1`,
  `gaps [6]`, `verify ok`, sync 9/9, reopen stabil.

## mode -> detektor (`src/log.ts` openLog)

| mode | suntik | deteksi saat reopen |
|---|---|---|
| `bitflip` | bit rendah index 1 (`"` -> `#`) di mid-file line, bukan last | `quarantined 1`, `gaps [line+1]`, `verify ok:true`, `events n-1` |
| `tornTail` | paruh akhir last line, tanpa trailing newline (kill mid-append) | `repairedTail true`, `events n-1`, `verify ok:true` |
| `truncateTail` | buang n tail line utuh di batas newline (lost suffix) | `events n-drop`, `quarantined 0`, `verify ok:true`, prefix valid |

`bitflip` menolak last line: itu teritori `tornTail`. `truncateTail`
menolak `dropLast >= total`: jangan kosongkan log via corruptor.

## run

- `bun test test/corrupt-gen.test.ts`: 3 pass, 0 fail (~0.5s).
- `bun test test/corrupt.test.ts`: 1 pass, 0 fail (~0.5s, pola acuan tetap hijau).
- base: `d03e683` (`v0.14.13`), 35 test files; suite penuh tidak diulang
  di sini (soak/flake ~300s+, timeout 120s pada run bukti).
