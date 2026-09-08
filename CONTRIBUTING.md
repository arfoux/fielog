# Contributing

## Setup

```sh
bun install
bun test            # full suite (218 test saat docs ini ditulis)
bun run build       # typecheck via tsc -p tsconfig.json
bun bin/fielog.ts demo   # smoke end-to-end kasir 2 HP
```

Syarat: `bun` >= 1.0 (lihat [docs/install](docs/install.md)).

## Alur kerja

1. Baca [docs/architecture](docs/architecture.md) + [docs/contracts](docs/contracts.md)
   sebelum menyentuh `src/` — kontrak di sana mengikat.
2. Ubah kode + test yang menjepit perilakunya (satu perilaku = satu test).
   Klaim docs baru wajib menunjuk file:line kode.
3. `bun test` file yang tersentuh dulu; full suite + `bun run build`
   sebelum PR.
4. Commit kecil, pesan jelas (`<area>: <apa + kenapa>`).
   Tulis CHANGELOG di bawah `Unreleased` bila perubahan user-visible.
5. PR: deskripsikan perilaku sebelum/sesudah + bukti run
   (paste output test/bench yang relevan). Tanpa bukti run = belum siap review.

## Gaya

- Boring dulu: pola yang ada menang atas pola baru. Satu konvensi per file.
- Fix sumber, bukan gejala: jangan bungkam warning/exception atau
  special-case input kecuali diminta.
- Tanpa formatter/linter terpusat — ikuti gaya file yang disentuh.
- Dilarang: stub/placeholder/`TODO: implement` sebagai "selesai";
  angka performa hasil karangan (hanya tulis yang diukur — lihat
  [docs/bench](docs/bench.md)); link docs yang tidak diklik-verifikasi.

## Yang tidak diterima

- Perubahan kontrak ([docs/contracts](docs/contracts.md)) tanpa diskusi
  dulu di issue.
- Field log baru yang melanggar superset rule ([docs/compat](docs/compat.md)).
- Test yang mengunci wording/implementasi insidental — test perilaku,
  bukan plumbing (lihat aturan verifikasi di repo induk bila ada).
