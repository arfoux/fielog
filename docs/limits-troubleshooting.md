# limits-troubleshooting

Batasan jujur + cara keluar dari masalah umum. Tanpa janji palsu.

## batasan desain

- Bun only. `bun:sqlite` + `Bun.serve` tidak ada di Node (`docs/install.md`).
- Satu proses per file. Dua penulis beda proses di satu `kasir.log` /
  `cas.json` balap last-write-wins (lihat [cas-store](cas-store.md)).
- Outbox berbatas: default 50_000 event belum sync, lewat itu `append`
  throw `ERR_OUTBOX_FULL` (`maxPending`, `src/kernel.ts`). Sync untuk
  menguras, atau naikkan sadar (`maxPending`) untuk build bench raksasa.
- Relay unsigned = siapa pun boleh mengaku device apa pun. Produksi wajib
  `--trust` + token (lihat [auth](auth.md)).
- Token kapabilitas self-signed: bocor = bisa dipakai pemegangnya sampai
  expiry/revoke. Minta pendek + rotasi.
- Hidden bukan enkripsi: `kernel.query` SQL mentah tetap melihat baris
  hidden; hold tidak tersync ke peer (lihat
  [tombstone-engine](tombstone-engine.md)).
- `quota.ts` standalone: tidak ada wiring kernel; caller reserve manual
  (lihat [quota-guard](quota-guard.md)).
- `deltasync.ts` tanpa verifikasi tanda: hanya untuk replika tepercaya
  satu operator (lihat [sync-protocol](sync-protocol.md)).
- Bench query 100k butuh build ~259 dtk sekali jalan; latensi di
  [bench](bench.md) adalah steady-state pasca-build.

## troubleshooting

| gejala | sebab kemungkinan | jalan keluar |
|---|---|---|
| `ERR_DEVICE_MISMATCH` saat buka | `deviceId` eksplisit beda dari id eksplisit tersimpan | buka dengan id tersimpan, atau file baru untuk device baru |
| `ERR_OUTBOX_FULL` | outbox ≥ cap | `sync`, lalu append lagi |
| `bayar rejected: nominal ...` | nominal tidak integer positif | perbaiki input; tidak ada baris log tertulis (fail-fast) |
| `bayar rejected: state ...` | state selain `DRAFT`/`IOU_RECORDED` | settlement hanya via `settle`/ack online |
| `ERR_UNKNOWN_TARGET` (hide/hold) | id salah ketik / target belum sync | cek id; kompensator buta (`undo`/`settle`) tidak butuh target lokal |
| `ERR_NOT_HIDDEN` (show) | id memang tidak hidden | tidak ada baris tertulis; cek `hiddenIds` |
| `serve butuh --trust ...` (exit 2) | serve tanpa registry | tambah `--trust id=pub.pem` atau `--unsigned` (dev) |
| `relay rejected push/pull` | token scope salah / device terevoke / tak dikenal | cek scope token, expiry, registry `--trust`, status revoke |
| sync macet di satu event | poison/pemalsu — by design dikarantina, cursor maju | cek `_quarantine` via `listQuarantine`; data bukti tetap ada |
| `health().repairedTail = true` | kill di tengah append; ekor robek dipotong saat buka | normal; data utuh = sampai seq terakhir valid |
| `health().gaps` non-kosong | seq di-anchore ulang setelah baris karantina | celah yang diketahui, bukan tamper (lihat [quarantine](quarantine.md)) |
| port sudah dipakai | relay lama masih hidup | `kill` proses lama / `--port` lain; `start()` ganda throw `relay already started` |
| `ERR_QUOTA_EXCEEDED` | file melebihi ceiling guard | release reservasi / naikkan ceiling |
| `ERR_QUOTA_UNKNOWN` | path tak bisa di-stat | perbaiki permission/path; guard fail-closed |

## minta tolong

Sertakan: versi (`package.json`), perintah persis, pesan error persis,
`health()` + `verifyLog()` bila soal log. Lapor sesuai
[SECURITY](../SECURITY.md) bila soal keamanan.
