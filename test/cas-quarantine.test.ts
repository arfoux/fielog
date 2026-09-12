import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casPathFor, openCas } from "../src/cas.ts";

describe("cas quarantine preserves refcount", () => {
  test("mismatch holds serve but keeps evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "cas-q-"));
    const cas = openCas(dir);
    const key = cas.put("hello");
    cas.link(key); // refcount 2: two holders
    expect(cas.stat(key)?.refcount).toBe(2);
    // Corrupt the blob on disk.
    writeFileSync(casPathFor(dir, key), "tampered!!!");
    expect(cas.get(key)).toBeNull(); // fail-closed: no serve
    expect(cas.has(key)).toBeFalse();
    // Evidence retained: refcount survives, stat still reports it.
    expect(cas.stat(key)?.refcount).toBe(2);
    // Manifest records the corrupt key in the quarantine section.
    const manifest = JSON.parse(readFileSync(join(dir, "cas.json"), "utf8"));
    expect(manifest.quarantined).toContain(key);
    expect(manifest.refs[key]).toBe(2);
    // Other holder can still release refs; final unlink clears quarantine.
    expect(cas.unlink(key)).toBeFalse();
    expect(cas.stat(key)?.refcount).toBe(1);
    expect(cas.unlink(key)).toBeTrue();
    expect(cas.stat(key)).toBeNull();
  });
});
