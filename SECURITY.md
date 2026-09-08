# Security Policy

## Melapor

Temukan celah? Jangan buka issue publik dulu. Kirim deskripsi + langkah
repro ke maintainer repo ini lewat DM/kontak yang tercantum di profil repo
atau commit terbaru. Belum ada alamat security khusus — kontak maintainer
langsung adalah kanal resmi.

Sertakan: versi (`package.json`), file/line yang terdampak, dampak
(apa yang bisa dilakukan penyerang), dan PoC minimal bila ada.

## Scope

Dalam scope: `src/` (log chain, store apply, sync verify, relay authorize,
auth, retain clamp, tombstone guard, cas re-hash, quota fail-closed),
`bin/fielog.ts` (mode tanda default), `demo/` + `example/` sebagai pola
yang dicopy pengguna.

Di luar scope: hardening deployment milik pengguna (TLS terminasi, firewall,
manajemen kunci produksi), dan relay `--unsigned` yang disengaja terbuka
(sudah didokumentasikan dev-only di [docs/cli](docs/cli.md)).

## SLA respon

Repo solo/small-team — jujur, bukan janji enterprise:

- Konfirmasi diterima: <= 72 jam.
- Penilaian + rencana fix: <= 7 hari untuk yang berdampak.
- Perbaikan: prioritas di atas fitur; dirilis + dicatat di CHANGELOG.
- Bila belum ada kabar dalam 14 hari, ping ulang sekali — lalu boleh
  full-disclosure bertanggung jawab.

## Yang sudah dijepit

Threat model hidup di `docs/`: token ([capability-token](docs/capability-token.md)),
revoke ([revoke-handshake](docs/revoke-handshake.md),
[revoke-event-log](docs/revoke-event-log.md)), karantina
([quarantine](docs/quarantine.md)), kontrak anti-hilang-data
([contracts](docs/contracts.md)). PR keamanan sebaiknya menambah test yang
menjepit celahnya, bukan hanya tambalan.
