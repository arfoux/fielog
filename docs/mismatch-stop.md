# mismatch-stop

Aturan rekursif: setiap klaim angka/hash/file/tag HARUS dibuktikan dengan
perintah sebelum dipakai. Klaim != bukti -> STOP, tulis laporan, jangan lanjut.
Aturan ini berlaku untuk aturan itu sendiri: verifikasi precondition kerjamu
di awal (lihat "verifikasi diri" di bawah).

## precondition per jenis spin

| spin | precondition | perintah bukti | lolos jika |
|---|---|---|---|
| test-count | suite hijau dengan jumlah pass sesuai base | `bun test 2>&1 \| tail -4` | `pass 66, fail 0` pada base `a9a6b41` |
| base-hash | HEAD sama dengan base yang diminta | `git rev-parse HEAD` | prefix cocok penuh dengan hash base (`a9a6b41...`) |
| file-scope | kerja HANYA di worktree dispatch ini, hanya file tugas | `pwd` + `git status --short` | cwd = worktree dispatch, tidak ada modifikasi di luar scope |
| tag-format | commit lowercase ascii tanpa emoji; tag `vX.Y.Z` | `git log -1 --format=%s` + `git tag \| tail -3` | tidak ada huruf kapital / non-ascii / emoji; tag cocok `v[0-9]*` |

Cara cek cepat semuanya sebelum mulai kerja:

```
git rev-parse HEAD          # base-hash
bun test 2>&1 | tail -4     # test-count (tunggu sampai selesai, jangan tail lalu pergi)
pwd; git status --short     # file-scope
git log -1 --format=%s      # tag-format (untuk commit yang akan dibuat)
```

Satu saja precondition gagal -> STOP. Tidak ada "lanjut dulu, bukti menyusul".

## format laporan STOP

Setiap STOP wajib memuat tiga kolom ini, tanpa kecuali:

| kolom | isi |
|---|---|
| klaim | apa yang dinyatakan (angka/hash/file/tag + sumbernya: siapa, kapan) |
| aktual | apa yang terukur di mesin ini |
| perintah bukti | perintah persis yang menghasilkan kolom aktual (copy-pasteable) |

Template:

```
STOP: <jenis spin>
klaim:   <nilai> (sumber: <dispatch/task/komitmen>)
aktual:  <nilai terukur>
bukti:   <perintah persis>
```

## contoh nyata wave-1

### 1. test-count: 66-vs-64

```
STOP: test-count
klaim:   66 pass, 0 fail (sumber: status base wave-1)
aktual:  64 pass, 0 fail
bukti:   bun test 2>&1 | tail -4
```

2 test hilang: suite tidak gagal, tapi jumlah pass tidak sama dengan klaim.
Itu tetap mismatch — STOP, bukan "hampir hijau". Penyebab waktu itu:
dua file test tidak ikut jalan di worktree tersebut.

### 2. base-hash: 219cc96-vs-3aa0492

```
STOP: base-hash
klaim:   base 219cc96 (sumber: brief dispatch wave-1)
aktual:  HEAD 3aa0492
bukti:   git rev-parse HEAD
```

Worktree berdiri di atas commit yang salah. Semua verifikasi di atas base
yang salah tidak berlaku untuk tugas itu — STOP, pindah/cocokkan base dulu,
baru mulai kerja.

## verifikasi diri (dispatch w2-mismatch-stop)

Precondition kerja dokumen ini, diukur sebelum/selama menulis:

```
bukti base-hash:
  perintah: git rev-parse HEAD
  aktual:   a9a6b4134850d8e64096b386a951eb94a8ace466
  cocok dengan base a9a6b41 -> LOLOS

bukti file-scope:
  perintah: pwd; git status --short
  aktual:   C:/Users/HP/orca/workspaces/fielog/w2-mismatch-stop, bersih
  hanya menyentuh docs/mismatch-stop.md -> LOLOS

bukti test-count:
  perintah: bun test 2>&1 | tail -4
  aktual:   66 pass, 0 fail, 28 files, 300.31s
  cocok dengan klaim base hijau 66/0 -> LOLOS
```
