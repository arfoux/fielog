// flake-hunter script tests: classifier unit checks via --from-log fixtures
// plus one live loop (skew, 2 runs) proving the rerun+summary path.
// no sockets, no kill signals, no timing dependence: fixtures are canned
// log text, the live target is the deterministic skew suite (~0.5 s/run).
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/flake-hunter.sh', import.meta.url));

function run(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(['bash', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    code: p.exitCode,
    out: (p.stdout.toString() + p.stderr.toString()).trim(),
  };
}

function fixture(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-flakehunter-'));
  const f = join(dir, name);
  writeFileSync(f, body);
  return f;
}

describe('flake-hunter --from-log classifier', () => {
  it('labels a waitFor timeout log as env (exit 0)', () => {
    const f = fixture('env.log', 'error: waitFor timed out after 15000ms\n(fail) kill9 recovery\n');
    const r = run(['--from-log', f]);
    assert.equal(r.code, 0);
    assert.match(r.out, /class=env/);
  });

  it('labels an assertion log as product (exit 2)', () => {
    const f = fixture(
      'prod.log',
      '(fail) soak seed 7\nerror: assert.equal(sqlTotal, model.expected): sql total diverges from model\n',
    );
    const r = run(['--from-log', f]);
    assert.equal(r.code, 2);
    assert.match(r.out, /class=product/);
  });

  it('product wins when a log mixes timeout noise with an assertion', () => {
    const f = fixture(
      'mixed.log',
      '(fail) failover ws\nerror: websocket closed 1006, retrying\nassert.equal(res.acked, 20): expected 20, got 17\n',
    );
    const r = run(['--from-log', f]);
    assert.equal(r.code, 2);
    assert.match(r.out, /class=product/);
  });

  it('labels an unknown failure with no pattern as product (never hides bugs)', () => {
    const f = fixture('unknown.log', '(fail) something odd\nerror: mysterious exit, no details\n');
    const r = run(['--from-log', f]);
    assert.equal(r.code, 2);
    assert.match(r.out, /unknown-failure-no-pattern/);
  });

  it('labels a green log as pass, not product', () => {
    const f = fixture('pass.log', ' 1 pass\n 0 fail\nRan 1 test across 1 file.\n');
    const r = run(['--from-log', f]);
    assert.equal(r.code, 0);
    assert.match(r.out, /class=pass/);
  });

  it('missing log file is a usage error (exit 1)', () => {
    const r = run(['--from-log', join(tmpdir(), 'fielog-flakehunter-nope.log')]);
    assert.equal(r.code, 1);
  });

  it('no flags is a usage error (exit 1)', () => {
    const r = run([]);
    assert.equal(r.code, 1);
  });
});

describe('flake-hunter live loop', () => {
  it('runs skew twice and prints a 2/2 summary (exit 0)', () => {
    const r = run(['--target', 'test/skew.test.ts', '--runs', '2']);
    assert.equal(r.code, 0);
    assert.match(r.out, /runs=2 pass=2 fail=0/);
    assert.match(r.out, /pass_rate=100%/);
  }, 60_000);
});
