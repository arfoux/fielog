# retention

Batasi log tanpa kehilangan kebenaran: snapshot + truncate (`src/retain.ts`).
Hanya prefix yang sudah di-ack (relay sudah memegangnya) yang boleh disapu,
dan cutover selalu tulis-file-baru + rename atomik.

## API (`src/retain.ts`)

```ts
interface SnapshotResult { snapshot: string; sealedSeq: number; dbSeq: number }
interface TruncateResult { removed: number; kept: number; sealedSeq: number }
snapshotPathFor(dbPath: string): string; // 'kasir.db' -> 'kasir.snapshot.db'
takeSnapshot(store, dbPath, sealedSeq, dest?): SnapshotResult;
// Online full copy (VACUUM INTO) + stempel seal di meta snapshot DAN live.
clampSealToStored(store, logSeqs, sealed, ackSeq): number;
// Jepit seal ke prefix yang aman disapu (maks = acked & terterapkan).
sweepLogFile(logPath, sealedSeq, syncDir?): TruncateResult;
// Sapu baris seq <= sealedSeq. File baru = marker + baris kept; rename atomik.
```

Via kernel (`src/kernel.ts`): `snapshot(dest?)`, `truncate()`.
`truncate` no-op bila belum disegel (`sealed <= 0`), dan menutup–membuka
ulang fd log di `finally` agar kernel tetap usable apapun hasilnya.
Setelah sapu, replay inkremental suffix kept + `exciseMissing` dengan
`sealedBelow` (prefix tersapu dimaafkan, karantina tidak).

## alur pakai

```ts
await k.snapshot();    // segel prefix acked ke kasir.snapshot.db
await k.truncate();    // sapu prefix tersegel dari kasir.log
```

Baris pertama log tersapu = marker `fielog-truncate` yang merantai suffix
ke prefix yang dibuang, jadi `verifyLog` tetap utuh.

## aturan yang mengikat

- `seal <= ack`: sweep tidak boleh menghapus data yang belum di-ack atau
  belum teraplikasi; seal basi = no-op aman (lihat [contracts](contracts.md)).
- `guardSeal` (lihat [tombstone-engine](tombstone-engine.md)) lebih ketat
  lagi: tahan event ber-legal-hold dan jangan belah pasangan hide/target.
- Snapshot ganda yang tumpang-tindih atas db yang sama ditolak loud
  (`snapshotsInFlight`), bukan di-interleave.
