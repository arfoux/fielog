// bench-pin.test.ts — locks bench-check.sh corpus strings to bench/*.ts constants.
// If a workload param changes in bench source, the corpus pin must change too.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("bench corpus pin matches bench sources", () => {
  const check = read("scripts/bench-check.sh");
  const append = read("bench/bench-append.ts");
  const query = read("bench/bench-query.ts");
  const sync = read("bench/bench-sync.ts");

  // append: N default 5000, value 1000+(i%9000), actor bench
  expect(append).toContain("5000");
  expect(append).toContain("1000 + (i % 9000)");
  expect(append).toContain("actor: 'bench'");
  expect(check).toContain("append) CORPUS=\"n=$N value=1000+(i%9000) actor=bench\"");

  // query: N default 100_000, iters 200, warmup 10, maxPending N+1000
  expect(query).toContain("100_000");
  expect(query).toContain("const ITERS = 200");
  expect(query).toContain("const WARMUP = 10");
  expect(query).toContain("maxPending: N + 1000");
  expect(check).toContain("query) CORPUS=\"n=$N iters=200 warmup=10 maxPending=n+1000");

  // sync: N default 10_000, chunk 500, fast 1/30ms
  expect(sync).toContain("10_000");
  expect(sync).toContain("const CHUNK = 500");
  expect(sync).toContain("baseMs: 1, maxMs: 30");
  expect(check).toContain("sync) CORPUS=\"n=$N chunk=500 relay=ws-real fast=1/30ms\"");
});
