# decision log — drop-18 iou-machine

status: DROP
base: 0f89faf (v0.14.25)
suite: 142 pass, 0 fail, 46 files (`bun test`, 212.85s)

## vonis

drop-18 iou-machine: DROP. tidak ada tipe/event utang antar-kasir yang
dibangun. money-state selesai lewat settle/sync-ack yang sudah ada;
gagal-ya-gagal, bukan utang.

## alasan

1. nol tipe/event utang antar-kasir. tidak ada `hutang` / `talangan` /
   `pinjam` sebagai tipe event maupun kolom read-model. transfer nilai
   antar device hanya terjadi lewat sync event yang sudah ada.
2. money-state selesai via settle/sync-ack. offline hanya mencatat
   DRAFT / IOU_RECORDED; SETTLED_ONLINE hanya lewat
   `payment.settled`, dan FAILED / EXPIRED merekam hasil akhir lokal.
   tidak ada state keempat berupa utang.
3. gagal-ya-gagal bukan utang. `payment.failed` / `payment.expired`
   adalah terminal, dan settle ganda / settle-setelah-fail menjadi
   konflik `double-settle` untuk rekonsiliasi manusia, bukan LWW.
   tidak ada jalan memutar yang mengubah gagal menjadi tagihan.

## bukti file:baris

- test/two-device.test.js:29 — `a.append({ type: 'bayar', nominal: 77000 })`
  offline tanpa relay; tidak ada payload utang.
- test/two-device.test.js:35 — `SELECT SUM(nominal) ... FROM bayar`
  konvergen di sisi penerima lewat sync idempoten (uuid), bukan lewat
  event utang.
- demo/kasir-2hp.ts:22-34 — 20 transaksi offline di hp1 lalu sync dua
  sisi sampai total sama; tidak ada langkah talangan antar-kasir.
- src/store.ts:50-82 — MoneyState (DRAFT, IOU_RECORDED, SETTLED_ONLINE,
  FAILED, EXPIRED) + checkAppend menolak state bayar selain DRAFT /
  IOU_RECORDED saat offline.
- src/kernel.ts:67-68 — `settle(eventId, outcome, actor)`: 'settled'
  butuh online ack; failed/expired tercatat lokal.

## asumsi tertulis

1. satu trust-domain: kedua kasir milik pemilik yang sama.
2. bayar lunas: tiap `bayar` dianggap tunai lunas di tempat; tidak ada
   cicilan, titip, atau ganti-rugi antar-kasir.

## klausul kedaluwarsa

bila talangan antar-kasir menjadi kebutuhan nyata (kasir A membayar
untuk kasir B dan menagih kemudian), vonis DROP ini gugur. rancang dari
kebutuhan nyata saat itu: definisi pelunasan, bukti, dan batas — bukan
dari spekulasi hari ini.

## verifikasi

- `bun test` -> 142 pass, 0 fail, 46 files.
- mismatch-stop: klaim angka/file:baris di atas hanya dari output
  perintah dan bacaan berkas di mesin ini; klaim != bukti -> STOP.
