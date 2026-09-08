# install

Cara memasang fielog dan syarat runtime-nya.

## syarat

- `bun` >= 1.0 wajib di runtime. Alasannya konkret, bukan selera:
  `src/store.ts` memakai `bun:sqlite`, `src/relay.ts` memakai `Bun.serve`.
  Di Node polos keduanya tidak ada.
- TypeScript opsional (hanya untuk `bun run build` via `tsc -p tsconfig.json`).

## pasang

Paket `fielog` belum terbit di registry npm — `bun add fielog` /
`npm i fielog` 404 hari ini. Sampai terbit, pakai dari checkout repo:
runtime tidak butuh install apa pun selain `bun` itu sendiri
(tanpa `dependencies`). `bun install` di checkout hanya perlu untuk
devDeps (`tsc` buat `bun run build`).

Yang akan ikut terkirim saat terbit (`files` di `package.json`): `src`, `bin`,
`README.md`, `LICENSE`, `CHANGELOG.md`, `docs`.

## coba

Dari checkout repo:

```sh
bun bin/fielog.ts demo
```

`demo` menjalankan kasir 2 HP offline lalu sync mode tanda dan membuktikan
total sama di kedua sisi (`bin/fielog.ts:cmdDemo`).

## file yang lahir saat dipakai

`createKernel({ file: 'kasir.db' })` membuat dua file (`src/kernel.ts:logPathFor`):

| file | isi |
|---|---|
| `kasir.db` | SQLite read-model, bisa dibuka di DBeaver |
| `kasir.log` | JSONL append-only, `tail -f` friendly, fsync per append |

Keduanya harus ikut di-backup / ikut pindah. Lihat [retention](retention.md)
untuk snapshot + truncate.

Lanjut: [quickstart](quickstart.md).
