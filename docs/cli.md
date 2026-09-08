# cli

Referensi `bin/fielog.ts`. Tiap flag di bawah terverifikasi terhadap kode —
yang tidak ada di `usage()` / `arg()` tidak didokumentasikan.

```
pakai: fielog <serve|sync|demo> [opsi]
```

## `serve` — jalankan relay ws file-backed (`cmdServe`)

| flag | wajib | arti |
|---|---|---|
| `--port <n>` | tidak (default `8091`) | port listen (`Number(arg(rest,'--port','8091'))`) |
| `--file <relay.log>` | tidak (default `relay.log`) | file persistensi JSONL relay |
| `--trust <id=pub.pem>` | ya, kecuali `--unsigned` | daftarkan device tepercaya; boleh diulang per device; format harus `id=path`, pubkey dibaca + trim, tak terbaca = `die` exit 2 |
| `--unsigned` | alternatif `--trust` | relay terbuka warisan: terima `device_id` apa pun. Hanya dev lokal |

Tanpa `--trust` dan tanpa `--unsigned` → `die('serve butuh --trust ...')`,
exit 2. Saat jalan, cetak `fielog relay listening ws://127.0.0.1:<port>
file=<file>` + `ready port=<port>`; hidup sampai `SIGINT`/`SIGTERM`.

```sh
bun bin/fielog.ts serve --port 8091 --file ./relay.log --trust kasir=./kasir.pub
bun bin/fielog.ts serve --port 8091 --file ./relay.log --unsigned   # dev saja
```

## `sync` — dorong+tarik delta satu file kernel (`cmdSync`)

| flag | wajib | arti |
|---|---|---|
| `--file <kasir.db>` | ya | file kernel lokal |
| `--relay <ws url>` | ya | URL relay, mis. `ws://127.0.0.1:8091` |
| `--key <priv.pem>` | ya, kecuali `--unsigned` | privkey device; token kapabilitas dicetak via `kernel.capToken` |
| `--as <device>` | ya bila `--key` | id device penanda + pemilik token |
| `--unsigned` | alternatif `--key/--as` | tanpa tanda (dev saja) |

`--key` tanpa `--as` → `die` exit 2. Sukses cetak
`sync pushed=<n> acked=<n> pulled=<n> applied=<n>`; client + kernel selalu
ditutup (`finally`). Catatan: sync CLI selalu chunk default (`chunkSize`
default 10 di `pushPending`) — untuk bulk pakai API `kernel.sync` dengan
`{ chunkSize: 500 }`.

```sh
bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --key ./kasir.priv --as kasir
bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --unsigned   # dev saja
```

## `demo` — kasir 2 HP (tanpa flag)

`bun bin/fielog.ts demo`: 20 penjualan offline di hp1, sync dua sisi mode
tanda, lalu membuktikan `hp1 == hp2 == expected`, else exit 1
(`cmdDemo`). Keluar: `sync: hp1 = ... | hp2 = ... | mau = ...` dan
`sama dua sisi, total cocok`.

## exit code

`0` sukses; `1` demo total beda; `2` pemakaian salah (pesan + usage ke
stderr, tulis sinkron sebelum exit agar tidak hilang saat pipe).
