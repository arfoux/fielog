# cas-store

Skill-14 (SOLID) port: content-addressed blob store for attachments
(game snapshots, file versions, telemetry batches — photo attachments and note
bodies are one domain). The sha256 of the bytes IS the key, so
identical bytes stored twice cost one blob plus a refcount. Refs are
explicit; the blob dies at zero; reads re-hash and quarantine on
mismatch, never serve corrupt bytes.

## operations (`src/cas.ts`)

| op | symbol | meaning |
|---|---|---|
| key | `casKeyFor(data)` | sha256 hex of the bytes, no registry |
| put | `openCas(dir).put(data)` | store bytes, add one ref; dedup shares the blob |
| get | `cas.get(key)` | bytes, or null when missing/unreadable/mismatched |
| link/unlink | `cas.link(key)` / `cas.unlink(key)` | add/drop one ref; unlink at zero deletes the blob |
| stat | `cas.stat(key)` | `{ key, size, refcount }` or null |
| gc | `cas.gc()` | sweeps manifest entries whose blob went missing |
| paths | `casPathFor` / `casQuarantinePathFor` | blob and forensic-quarantine locations |

Layout under `<dir>`: `sha/<ab>/<rest>` blobs, `cas.json` ref table
(atomic tmp + fsync + rename per mutation, same cutover as `retain.ts`),
`quarantine/<key>` bitrot forensics. The blob is exclusively created
before the manifest names it, so a kill between ops never leaves a ref
pointing at a half-written blob.

## evidence (`test/cas.test.ts`)

Put returns the sha256 key and round-trips; same bytes twice share one
blob at refcount 2 and die on the second unlink; link/unlink of unknown
keys throw (no phantom refs); refs survive reopen; bitrot on read
quarantines exactly once and is never served; gc sweeps entries whose
blob went missing; a corrupt manifest fails closed.

```
bun test test/cas.test.ts   # 7 pass, 0 fail
```

Baseline at this HEAD (per-file, `timeout 120` each, no hanger this run):
36 files, 95 pass, 0 fail — below main `fbb2d16` 116/0/41 because this
branch predates quota/tombstone/compat, not because anything regressed.

## limits

Single-process: concurrent writers in two processes can race the
manifest last-write-wins (same constraint as the JSONL log writers).
`get` on a non-hex key returns null instead of throwing; only
`link`/`unlink` throw, because a phantom ref is a caller bug while a
missing blob on read is an environment fact. Tombstone/legal-hold
integration is out of scope: unlink deletes at zero unconditionally.
