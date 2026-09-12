# fielog decisions — 5 keputusan lisan, kini tertulis

Date: 2026-09-12. Bahan: `src/auth.ts`, `src/relay.ts`, `docs/contracts.md`.
Tak ada keputusan lisan tersisa setelah berkas ini.

## 1. Epoch token: wont-fix, reissue = UUID baru

- Keputusan: `CapToken` tanpa field `epoch`. Revokasi membunuh satu id penuh. Reissue = mint UUID baru; sibling lama mati, sibling baru hidup.
- Konteks: `CapToken` = `{ id, deviceId, scopes, issuedAt, expiresAt, notBefore?, signature? }` (`src/auth.ts:148-156`); mint pakai `randomUUID`, tanpa epoch (`src/auth.ts:168-183`); verify fail-closed untuk token tanpa id, `expiresAt <= issuedAt`, expiry, revokasi per id (`src/auth.ts:199-215`). Sisi revoke: `isRevoked(tokenId, tokenEpoch = 0)` (`src/revokelog.ts:267`), `isTokenRevoked(tokenId, tokenEpoch = 0)` (`src/relay.ts:257`); `CapToken` selalu epoch 0 karena tak ada fieldnya. Kebijakan tertulis: "`CapToken` ids are random UUIDs with no epoch, so any event for the id kills it" (`docs/revoke-handshake.md:44-48`).
- Alternatif ditolak: tambah `epoch` ke canonical token. Duplikat mekanisme revoke-event epoch ke token, pecah canonical form + verify + migrasi, tanpa kebutuhan nyata.
- Revisit iff: butuh rotasi id-stabil (reissue id sama, epoch naik, revoke lama hanya bunuh epoch lama). Syarat: bukti kebutuhan + rencana migrasi (token lama tanpa epoch fail-closed, re-mint). Sampai itu: UUID baru per reissue.

## 2. `dist/`: out-of-scope, run kanonis via `src` + bun

- Keputusan: `dist/` artefak build lokal. Jangan baca, edit, kutip, atau publish. Run kanonis = bun atas TS `src` langsung; `tsc` hanya verifikasi ketik/build.
- Konteks: `tsconfig.json` (`outDir: dist`, `rootDir: src`); `.gitignore` daftar `dist/`; `package.json` (`main: src/index.ts`, `bin: ./bin/fielog.ts`, `files: [src, bin, README, LICENSE, CHANGELOG]` — tanpa `dist`); scripts kanonis `bun test`, `bun bench/bench-*.ts`, `bun demo/two-node.ts`, `build: tsc -p tsconfig.json`.
- Alternatif ditolak: run via `node dist/*` sebagai acuan. Duplikat sumber kebenaran, basi setelah tiap edit `src`.
- Revisit iff: publish butuh JS kompilasi. Maka ubah `files` + run kanonis eksplisit, bukan diam-diam.

## 3. Relay tanpa enkripsi; rahasia via WireGuard (runbook moltarc)

- Keputusan: relay tetap ws polos (`Bun.serve`, tanpa TLS di kode). Auth beri integritas + autentikasi, bukan kerahasiaan. Antar site / lewat internet: bungkus TCP di WireGuard.
- Konteks: relay "accept raw log, broadcast, store. No business logic", persist JSONL sebelum ack, live hanya hint (`src/relay.ts:1-5`); wire `push`/`pull` bawa `LogEvent` mentah + `CapToken` opsional (`src/relay.ts:57-62`); otorisasi = tombstone device → revokasi per id → signature → expiry → scope (`docs/capability-token.md:33-34`); bocor token = pemegang pakai penuh sampai expiry/revoke, tak terikat socket (`docs/capability-token.md:62-64`, `src/auth.ts:142-146`). Unsigned relay (registry kosong) = dev lokal saja; produksi fail-closed (`docs/auth.md:43-44`, `src/relay.ts:40-46`).
- Runbook: `../../molt/docs/wireguard-p2p.md` — kenapa tanpa enkripsi di kode (HMAC/auth tanpa kerahasiaan), pasang 2 peer, rotasi PSK, `allowPeers`, port/firewall, verifikasi handshake gagal.
- Alternatif ditolak: TLS di dalam `src/relay.ts`. Berat deploy untuk relay LAN; kerahasiaan antar site sudah dijawab tunnel.
- Revisit iff: relay wajib ekspos internet tanpa tunnel. Maka TLS/WSS jadi syarat, bukan opsi.

## 4. Claim: ephemeral, TTL default 15 mnt — milik moltarc, pointer saja

- Keputusan: fielog tanpa modul claim. Claim hidup di moltarc saja; fielog money-state selesai via resolve/sync-ack, bukan permit.
- Konteks moltarc (pointer, bukan duplikat): `ClaimStore` eksplisit EPHEMERAL in-memory; restart tanpa snapshot `toJSON` + restore `fromJSON` = spent jadi spendable lagi (double-spend), tanpa auto-persist (`../../molt/src/claim.ts:4-10`, `../../molt/src/claim.ts:63-65`); `DEFAULT_TTL_MS` 15 mnt dengan rasional jendela (`../../molt/src/claim.ts:41-46`); argumen omitted → default, eksplisit `undefined`/`null` → never-expire, numerik → custom (`../../molt/src/claim.ts:48-53`); `use()` kedaluwarsa lapor `expired`, tak pernah ditandai spent (`../../molt/src/claim.ts:97-105`); kontrak kanonis `../../molt/docs/contracts.md` → Claim TTL. Paralel fielog: TTL token relay `GRANT_TTL_MS` 24 jam / `CAP_TOKEN_TTL_MS` 15 mnt (`src/auth.ts:68-69`, `docs/capability-token.md:38-46`) — itu capability relay, bukan claim.
- Alternatif ditolak: claim engine kedua di fielog. Fork semantik expiry/persist/reconcile yang sudah ada di moltarc.
- Revisit iff: fielog butuh single-spend permit offline. Maka impor dari moltarc, jangan fork.

## 5. Bench tunggal bertanggal; kanonis CHANGELOG + honesty

- Keputusan: satu sumber angka = `docs/bench.md` bertanggal. Setiap angka hanya valid dengan pin slice + corpus + machine. `CHANGELOG.md` kanonis perubahan user-visible; `bench/honesty.md` + `scripts/bench-check.sh` gate kejujuran.
- Konteks: `docs/bench.md` ("Measured 2026-09-12 … no estimates", seksi machine + method + results); honesty = slice (git HEAD) + corpus (bench file + N + params) + machine (os/arch/bun), mismatch → STOP, tak ada estimasi (`bench/honesty.md:1-28`); checker exit 0 PASS / 2 FAIL / 1 usage (`bench/honesty.md:30-49`); angka lintas hari tak comparable (`bench/honesty.md:76-80`); `CHANGELOG.md` pola Unreleased → tag order, untagged folded.
- Alternatif ditolak: angka tersebar di chat/doc tanpa tanggal + pin. Tak bisa direproduksi = ditolak.
- Revisit iff: tak ada — aturan pin permanen. Bench baru = tanggal + pin baru, bukan rata-rata lintas hari.
