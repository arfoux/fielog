# hash-chain-log

Skill-12 (SOLID) port: append-only log where every event commits to its
predecessor. One corrupt line quarantines; the survivor re-anchors; the
chain stays verifiable.

## operations (`src/hashchain.ts`)

| op | symbol | meaning |
|---|---|---|
| append | `openHashChain(path, device).append(input)` | chains `prev_hash` to tip, fsync per write |
| verify | `chain.verify()` / `verifyChain(events, gaps?)` | replays hash + `prev` linkage |
| quarantine | open skips bad mid-file lines | forensics to `<path>.quarantine`, count on `chain.quarantined` |
| re-anchor | first kept seq after a gap verifies OK | reported as `gaps: [seq]` |

Chain math lives in `src/log.ts` (`canonicalOf`, `hashFor`, `openLog`);
this module is a facade so nobody reimplements checks by hand.

## evidence (`test/hashchain.test.ts`)

Append N=12, `verify()` OK; bitrot line 5; reopen quarantines 1,
`verify()` = `{ ok: true, gaps: [6] }`; append resumes at seq 13 from the
live tip; reopen stable with exactly 1 quarantine line. Pure
`verifyChain` rejects payload tamper even with a gap alibi.

```
bun test test/hashchain.test.ts   # 2 pass, 0 fail
```

## limits

Torn tail (kill mid-append) truncates on open (`repairedTail`), not
quarantine. Swept prefixes re-anchor via the truncate marker tip
(`sealedBelow`). Signatures cover the hash, never the reverse.
