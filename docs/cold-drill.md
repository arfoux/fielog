# cold-drill (adaptasi fielog)

Port skill-8 (`cold-drill`, status MANTAP) ke fielog DENGAN ADAPTASI.
Aslinya: hapus semua kecuali cold tier, buktikan node bangkit dari
cold tier saja. fielog tak punya cold tier (fakta wave-1) — satu-satunya
sumber kebenaran adalah log primer (`kasir.log`, JSONL hash-chain).
Drill ini menghapus semua KECUALI log primer dan membuktikan node
bangkit dari log saja via replay + verify.

## yang dihapus vs dipertahankan

| berkas | nasib | alasan |
|---|---|---|
| `kasir.log` (log primer) | DIPERTAHANKAN | satu-satunya sumber kebenaran |
| `kasir.db` + `-wal`/`-shm`/`-journal` (sqlite read-model) | DIHAPUS | turunan: dibangun ulang via replay |
| `kasir.snapshot.db` (snapshot retain) | DIHAPUS | turunan: salinan read-model + seal |
| `kasir.log.quarantine` (forensik baris korup) | DIHAPUS | turunan: dibuat ulang bila log korup dibaca ulang |

Mekanisme bangkit (`src/kernel.ts`, `createKernel`): `openLog` membaca
`kasir.log`, `store.replay` membangun ulang sqlite secara idempoten per
UUID, lalu `verify` memeriksa hash-chain. Uji memakai nominal
deterministik `1000+i` (`i = 0..n-1`), sehingga total harapan
`n*1000 + n*(n-1)/2` bisa dibandingkan persis sebelum vs sesudah.

## batas adaptasi vs aslinya

1. Tak ada fetch antar-tier yang diuji — tidak ada tier. Yang diuji
   murni replay lokal, bukan pengambilan dingin dari penyimpanan jauh.
2. Meta sqlite ikut hilang: `device.id` (skrip + uji memakai deviceId
   eksplisit agar stabil), cursor ack (sync berikutnya re-push dari
   seq 0 — aman karena idempoten per UUID, tapi ada duplikasi kirim),
   dan `snapshot.sealed_seq` (seal snapshot hilang).
3. Forensik quarantine ikut terhapus: riwayat baris korup yang pernah
   dikarantina tidak bertahan — log yang tersisa tetap diverifikasi
   ulang, celah bernama (`gaps`) muncul bila ada baris hilang.
4. Log yang pernah di-sweep tetap aman: marker `fielog-truncate` adalah
   baris pertama `kasir.log` sendiri, jadi ikut dipertahankan.

## pakai

```sh
bash scripts/cold-drill.sh [--n <events>] [--dir <path>] [--keep-dir]
```

| flag | default | arti |
|---|---|---|
| `--n` | 50 | jumlah event `bayar` deterministik yang disemai |
| `--dir` | tmp baru | direktori drill (dibuat via `mktemp` di `${TMPDIR:-${TEMP:-${TMP:-/tmp}}}`) |
| `--keep-dir` | hapus | pertahankan direktori drill untuk inspeksi |

Skrip hanya baca-tulis direktori drill-nya sendiri; tidak menyentuh
jaringan, relay, atau file repo. Kode keluar 0 bila `DRILL: PASS`
(event + total + verify identik sebelum/sesudah), 1 bila `DRILL: FAIL`
atau galat pemakaian/lingkungan.

## bukti run (2026-09-06, mesin ini)

```
BEFORE events=50 total=51225 expected=51225 verify=ok
log lines=50 bytes=15984 (want lines=50)
before delete: kasir.db kasir.db-shm kasir.db-wal kasir.log
after delete: kasir.log
AFTER events=50 total=51225 expected=51225 verify=ok gaps=[]
DRILL: PASS (n=50, replay from kasir.log only, totals identical, verify ok)
```

perintah bukti: `bash scripts/cold-drill.sh --n 50`
uji otomatis: `bun test test/cold-drill.test.ts` → `1 pass, 0 fail`
(skenario sama di dalam proses: semai 30 event, sisakan `kasir.log`,
buka ulang, nyatakan event + total + verify identik).

FASE-2 (merge + tag) hanya via instruksi inbox koordinator.
