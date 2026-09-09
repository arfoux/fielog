# fielog benchmarks

Measured 2026-09-05. Every number below is a real measurement from this
machine — no estimates. Re-run with `bun bench/bench-*.ts [N]`
(or `bun run bench:append | bench:query | bench:sync`).

## machine

- cpu: AMD Ryzen 5 PRO 5650U, 6 cores / 12 threads
- ram: 16 GB (15.3 GiB usable)
- disk: 512 GB AGI SSD (model AGI512G16AI198)
- os: Windows 11 Pro
- runtime: bun 1.4.0

## method

- `bench/bench-append.ts [N]` (default 5000): appends `payment` events
  (`amount` 1000..9999, `actor: bench`) to a fresh tmp kernel, times the
  whole run plus each append for per-op p50/p99.
- `bench/bench-query.ts [N]` (default 100000): builds N `payment` events,
  then 200 timed iterations (10 warmup) of two workloads against the
  SQLite read-model: `sum_all` (`SELECT SUM(amount) ... WHERE voided = 0`)
  and `point_by_seq` (`SELECT * FROM payment WHERE seq = ?`, deterministic
  stride `(i * 7919) % N + 1` covering each seq once per full cycle).
  `maxPending` is raised to N + 1000 so the outbox cap does not stop the build.
- `bench/bench-sync.ts [N]` (default 10000): device A appends N events,
  pushes to a real `WsRelayServer` over ws (`chunkSize: 500`), then a fresh
  device B pulls all N. Correctness is checked (`SUM(amount)` equal on both
  sides, `applied == N`); push, pull, and end-to-end rates are reported.

## results

| bench | n | result |
|---|---|---|
| append throughput | 5000 | 435 append/sec (total 11.48 s) |
| append per-op | 5000 | p50 2.191 ms, p99 3.370 ms |
| query `sum_all` (100k events) | 200 iters | p50 16.557 ms, p99 21.744 ms |
| query `point_by_seq` (100k events) | 200 iters | p50 0.052 ms, p99 0.118 ms |
| sync push over real ws relay | 10000 | 470 events/sec (21.29 s, chunk 500) |
| sync pull over real ws relay | 10000 | 232 events/sec (43.12 s, chunk 500) |
| sync end-to-end (push+pull) | 10000 | 155 events/sec |

## notes

- Append is dominated by fsync-per-append in the JSONL log plus a SQLite
  apply per event; that is the durability cost, not overhead to optimize away.
- Pull is slower than push because the pulling side fsync-appends every event
  to its own log and applies it to SQLite, while the push side mostly streams.
- The 100k query build took 258.9 s at the same append rate; query latencies
  above are steady-state on the finished 100k-event store in tmp.
