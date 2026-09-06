# multi-device-rig: rig kasir-01/kasir-02 -> konvergen

Skrip `scripts/two-device-rig.sh` menjalankan tiga skenario dua device
lewat satu relay memori (port of skill-11 multi-device-rig, SEHAT).
Referensi baca-saja: `test/two-device.test.js` (tidak diubah);
skenario rig tinggal di `test/two-device-rig.test.ts`.

## prasyarat

- base `main` = `d03e683` (`v0.14.13`); `bun test` hijau 88 pass / 0 fail.
- shell: `bash`, `git`, `bun`.

## prosedur

1. rig penuh (n default 20):
   `bash scripts/two-device-rig.sh`
2. rig dengan jumlah event lain:
   `bash scripts/two-device-rig.sh --n 50`
3. satu skenario saja:
   `bash scripts/two-device-rig.sh --filter s2`
4. klaim angka/hash/file HANYA dari output perintah di mesin ini
   (mismatch-stop): klaim != bukti -> STOP, tulis laporan, jangan lanjut.

## skenario

| id | nama | bukti konvergensi |
|---|---|---|
| s1 | kasir-01 jualan offline, kasir-02 tarik sampai sama | total dua sisi = jumlah n event; re-sync `applied=0` |
| s2 | dua arah tabrakan offline lalu konvergen | total dua sisi = jumlah gabungan 10+10 event |
| s3 | relay putus tengah batch lalu resume | `relay.size=n` (exact-once by uuid); total kasir-02 = jumlah n event |

## contoh output

```text
$ bash scripts/two-device-rig.sh
two-device-rig: n=20 filter=all
[two-device-rig] s1 total=147500 n=20 idempotent=ok
[two-device-rig] s2 total=59000 konvergen=ok
[two-device-rig] s3 total=20190 relay.size=20 resume=ok
two-device-rig: PASS pass=3 fail=0 n=20
```

s1 total = jumlah `5000 + i*250` untuk `i = 0..19` = 147500.
s2 total = jumlah `2000 + i*100` + `3000 + i*100` untuk `i = 0..9` = 59000.
s3 total = jumlah `1000 + i` untuk `i = 0..19` = 20190.

## tabel keputusan gagal

| kondisi | sinyal skrip | aksi |
|---|---|---|
| total dua sisi beda | `AssertionError` di skenario | STOP: cek urutan sync (s2 butuh ronde tarik kedua); jangan ubah ekspektasi |
| duplikat setelah resume | `relay.size != n` | STOP: dedupe uuid jebol; eskalasi, bukan retry manual |
| flag tidak dikenal / n bukan positif | `error: ...` + exit 2 | perbaiki flag, ulangi |
| test merah | `RIG: FAIL pass=? fail=?` | perbaiki di file rig; `test/two-device.test.js` tetap baca-saja |
