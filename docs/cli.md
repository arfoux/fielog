# cli

Reference for `bin/fielog.ts`. Every flag below is verified against the code —
anything absent from `usage()` / `arg()` is not documented.

```
usage: fielog <serve|sync|demo> [options]
```

## `serve` — run the file-backed ws relay (`cmdServe`)

| flag | required | meaning |
|---|---|---|
| `--port <n>` | no (default `8091`) | listen port (`Number(arg(rest,'--port','8091'))`) |
| `--file <relay.log>` | no (default `relay.log`) | JSONL persistence file of the relay |
| `--trust <id=pub.pem>` | yes, unless `--unsigned` | register a trusted device; repeatable per device; format must be `id=path`, pubkey is read + trimmed, unreadable = `die` exit 2 |
| `--unsigned` | alternative to `--trust` | legacy open relay: accepts any `device_id`. Local dev only |

Without `--trust` and without `--unsigned` → `die('serve needs --trust ...')`,
exit 2. While running, it prints `fielog relay listening ws://127.0.0.1:<port>
file=<file>` + `ready port=<port>`; lives until `SIGINT`/`SIGTERM`.

```sh
# one time only: mint the device key (standard PEM: PRIV PKCS#8, PUB SPKI)
openssl genpkey -algorithm ed25519 -out kasir.priv
openssl pkey -in kasir.priv -pubout -out kasir.pub
bun bin/fielog.ts serve --port 8091 --file ./relay.log --trust kasir=./kasir.pub
bun bin/fielog.ts serve --port 8091 --file ./relay.log --unsigned   # dev only
```

## `sync` — push+pull the delta of one kernel file (`cmdSync`)

| flag | required | meaning |
|---|---|---|
| `--file <kasir.db>` | yes | local kernel file |
| `--relay <ws url>` | yes | relay URL, e.g. `ws://127.0.0.1:8091` |
| `--key <priv.pem>` | yes, unless `--unsigned` | device privkey; the capability token is minted via `kernel.capToken` |
| `--as <device>` | yes with `--key` | signing device id + token owner |
| `--unsigned` | alternative to `--key/--as` | unsigned (dev only) |

`--key` without `--as` → `die` exit 2. On success prints
`sync pushed=<n> acked=<n> pulled=<n> applied=<n>`; client + kernel are always
closed (`finally`). Note: CLI sync always uses the default chunk (`chunkSize`
defaults to 10 in `pushPending`) — for bulk use the `kernel.sync` API with
`{ chunkSize: 500 }`.

```sh
bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --key ./kasir.priv --as kasir
bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --unsigned   # dev only
```

## `demo` — 2-phone kasir (no flags)

`bun bin/fielog.ts demo`: 20 offline sales on hp1, two-sided signed-mode sync,
then proves `hp1 == hp2 == expected`, else exit 1
(`cmdDemo`). Output: `sync: hp1 = ... | hp2 = ... | expected = ...` and
`match on both sides, totals agree`.

## exit code

`0` success; `1` demo totals differ; `2` wrong usage (message + usage to
stderr, written synchronously before exit so nothing is lost when piped).
