# contracts

Janji perilaku yang tidak boleh dilanggar. Tiap butir menunjuk ke kode —
bukan ke niat.

## 1. dead-letter: satu event beracun tidak pernah menjepit cursor

- Push: ack parsial berhenti, cursor maju hanya sampai yang di-ack;
  run berikut lanjut dari sana (`applyPushAck`, `src/sync.ts:134-184`).
- Pull: event poison (bentuk invalid) / pemalsu (tanda tak verif) /
  terevoke dikarantina ke `_quarantine` sebagai bukti, cursor tetap maju
  (`applyPullEvents`, `src/sync.ts:395-503`; gerbang pemalsu
  `verifyPullAuth`, `src/sync.ts:195-225`).
- Deltasync: UUID shape-invalid dicatat di meta `<cursorKey>.dead` dan tidak
  pernah di-fetch ulang; want-list tetap terkuras (`src/deltasync.ts:10-13`).

## 2. kompensator buta: undo/settle tidak butuh target lokal

`kernel.undo` / `settle` append event kompensasi tanpa mengecek target ada
(`src/kernel.ts:210-218`). Konvergensi via fold, bukan keberadaan lokal:
kompensasi yang tiba sebelum targetnya parkir di `records`/`conflicts` dan
bangkit saat target mendarat (`resolvePendingUndos`, `src/store.ts:233-267`).
Dijepit `scripts/model-oracle.ts` + `docs/model-oracle.md`.

## 3. seal <= ack: truncate tidak boleh memakan data belum aman

Seal snapshot dijepit ke prefix yang tersimpan DAN di-ack sebelum disapu
(`clampSealToStored`, `src/retain.ts:123-147`; dipakai kernel
`src/kernel.ts:248-254`). Seal basi = no-op. Di atasnya, `guardSeal`
(`src/tombstone.ts:190-232`) menahan event legal-hold dan menolak belah
pasangan hide/target (clamp di bawah KEDUA seq, fixpoint).

## 4. device.explicit: tolak split-brain, adopsi eksplisit pertama diizinkan

Meta `device.id` + `device.explicit` (`src/kernel.ts:108-126`): buka dengan
`deviceId` eksplisit yang beda dari id eksplisit tersimpan → throw
`ERR_DEVICE_MISMATCH`. Alur init-then-sync (file lahir tanpa id, lalu dibuka
dengan id eksplisit pertama) diadopsi dan ditandai eksplisit — hanya sekali.

## 5. purge inkremental: sapu revoke O(baru), bukan O(log)

`purgeRevoked` (`src/sync.ts:359-386`) melacak cursor `sync.purge_seq` +
fingerprint sinyal revoke (`sync.purge_revoke_fp`). State revoke sama =
hanya baris log baru yang dipindai; revoke baru = rescan penuh.
Predikat `isRevoked` tanpa `revokeVersion` selalu rescan (closure opak).

## 6. jitter deterministik default, acak itu opt-in

`backoffMs` (`src/sync.ts:74-88`): default jitter = `((attempt+1)*37) % 100`
— retry yang sama tidur millis yang sama di tiap run (test timing pin
eksak). `SyncOpts.jitter`: `true` = acak via `Math.random()`, number =
jitter tetap, fungsi = sumber `[0,1)` kustom.

## 7. kompat writer superset (v0.5)

Output writer = field v0.5 + opsional yang dikenal (`actor, origin_seq,
origin_device, server_time`); field baru wajib opsional + unhashed +
tidak rename/repurpose (`docs/compat.md`, `canonicalOf` di `src/log.ts`
= daftar beku). Fixture: `test/fixtures/v05-kasir.log`, dijepit
`test/compat-v05.test.ts`.
