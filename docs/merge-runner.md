# merge-runner: ff-only merge spin -> main

Skrip `scripts/merge-spin.sh` menggabungkan satu branch spin ke `main`
tanpa merge commit, hanya bila semua gerbang hijau. Tag eksak `v0.14.N`
dengan `N = 2 + urutan-merge`; urutan (`--order`) dikoordinasikan via
inbox koordinator supaya dua runner tidak pernah mengklaim N yang sama.

## prasyarat

- base `main` = `a9a6b41` (`v0.14.1`); `bun test` hijau 66 pass / 0 fail.
- `bun:sqlite` hanya di `src/store.ts`, `src/retain.ts` (mismatch-stop).
- shell: `bash`, `git`, `bun`. `shellcheck` bila ada (tidak wajib di runner).

## prosedur

1. klaim urutan: minta `--order k` via inbox koordinator, dapatkan `N = 2+k`.
2. dry-run dari worktree sendiri (tidak menyentuh `main`, branch, atau tag):
   `bash scripts/merge-spin.sh --spin <branch> --order <k> --dry-run`
3. bila `DRY-RUN OK`, lapor ke koordinator: commit hash, angka test,
   log dry-run. TUNGGU fase-2.
4. fase-2 HANYA via inbox koordinator (yang memegang `main`):
   `git checkout main && bash scripts/merge-spin.sh --spin <branch> --order <k>`
   lalu `git push origin main v0.14.N`.
5. JANGAN pernah merge ke `main` sendiri dari worktree dispatch.

## contoh output

dry-run (worktree `w2-merge-runner`, spin `w2-watchdog` 1 commit di depan
`main`, `--order 0` -> tag `v0.14.2`):

```text
$ bash scripts/merge-spin.sh --spin w2-watchdog --order 0 --dry-run
merge-runner: spin=w2-watchdog order=0 tag=v0.14.2 dry_run=1
merge-runner: base=fecf5eb branch=w2-merge-runner
merge-runner: tag v0.14.2 free
merge-runner: PRE bun test on main ...
merge-runner: PRE green ( 66 pass  0 fail )
DRY-RUN OK: would run: git merge --ff-only w2-watchdog && bun test && git tag v0.14.2
DRY-RUN OK: no branch, tag, or working tree was mutated
```

run nyata (fase-2, di checkout `main` oleh koordinator):

```text
$ git checkout main && bash scripts/merge-spin.sh --spin w2-watchdog --order 0
merge-runner: spin=w2-watchdog order=0 tag=v0.14.2 dry_run=0
merge-runner: base=a9a6b41 branch=main
merge-runner: tag v0.14.2 free
merge-runner: PRE bun test on main ...
merge-runner: PRE green ( 66 pass  0 fail )
Updating a9a6b41..e3f5a1b
Fast-forward
merge-runner: POST bun test on merged main ...
merge-runner: POST green ( 66 pass  0 fail )
merge-runner: DONE merged w2-watchdog -> main, tagged v0.14.2
```

## tabel keputusan gagal

| kondisi | sinyal skrip | aksi |
|---|---|---|
| tidak di `main` (mode nyata) | `REJECT: not on main` | `git checkout main`, ulangi |
| tree kotor (termasuk untracked) | `REJECT: dirty working tree` | commit/stash (`-u`), ulangi |
| branch spin tidak ada | `REJECT: spin branch ... does not exist` | perbaiki nama / fetch |
| tidak fast-forward | `REJECT: non-fast-forward` | rebase spin ke `main` di worktree spin, minta dry-run ulang; skrip TIDAK PERNAH merge commit |
| tidak ada yang di-merge | `REJECT: nothing to merge` | spin sudah di `main`; batal, klaim order hangus |
| tag `v0.14.N` sudah ada | `REJECT: tag ... already exists` | order `k` sudah terpakai; koordinasi ulang via inbox |
| PRE `bun test` merah | `REJECT: PRE bun test red` | merge DIBATALKAN; perbaiki di branch spin, bukan di `main` |
| POST `bun test` merah | `REJECT: POST bun test red ... UNTAGGED` | `main` sudah ter-merge tapi TANPA tag; STOP, eskalasi ke koordinator sebelum tagging/manual revert |
| format tag dilanggar | `error: generated tag ... violates exact format` | bug skrip; jangan tag manual, eskalasi |

## catatan desain

- `--ff-only` dipakai dua lapis: cek `merge-base --is-ancestor` di depan
  (pesan tolak yang jelas) plus flag `git merge --ff-only` saat eksekusi
  (anti-race bila `main` bergerak di tengah jalan).
- tag dibuat HANYA setelah POST hijau; `main` merah tidak pernah dapat tag.
- `set -euo pipefail`; cek sintaks: `bash -n scripts/merge-spin.sh`.
