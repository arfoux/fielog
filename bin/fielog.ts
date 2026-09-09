#!/usr/bin/env bun
// bin/fielog.ts — small CLI: serve the ws relay, sync a kernel file, run the 2-phone kasir demo.
// Bun only. Signed mode by default: serve needs --trust id=pub.pem (repeatable)
// and sync needs --key priv.pem --as <device>; --unsigned selects the legacy
// open relay (accepts any device_id, local dev only).
// examples:
//   bun bin/fielog.ts serve --port 8091 --file ./relay.log --trust kasir=./kasir.pub
//   bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091 --key ./kasir.priv --as kasir
//   bun bin/fielog.ts serve --port 8091 --file ./relay.log --unsigned
//   bun bin/fielog.ts demo
import { mkdtempSync, readFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, generateDeviceKey, WsRelayClient, WsRelayServer } from '../src/index.ts';

function usage(): string {
  return [
    'usage: fielog <serve|sync|demo> [options]',
    '  serve --port <n> --file <relay.log> --trust <id=pub.pem> [--trust ...]',
    '    run the file-backed ws relay in signed mode (rejects unknown devices)',
    '  serve --port <n> --file <relay.log> --unsigned   open relay (dev only)',
    '  sync --file <kasir.db> --relay <ws url> --key <priv.pem> --as <device>',
    '    push+pull the kernel delta with a capability token',
    '  sync --file <kasir.db> --relay <ws url> --unsigned   unsigned (dev only)',
    '  demo   2-phone kasir: offline sales, then signed-mode sync with matching totals',
  ].join('\n');
}

function arg(args: string[], name: string, def?: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return def;
  return args[i + 1] ?? def;
}

function argAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < args.length; i++) if (args[i] === name) out.push(args[i + 1]);
  return out;
}

function die(msg: string): never {
  // write synchronously: console.error + process.exit race when stderr is piped
  // (the cli-auth test reads the child process stderr; async writes can be lost).
  writeSync(2, msg + '\n' + usage() + '\n');
  process.exit(2);
}

async function cmdServe(rest: string[]): Promise<void> {
  const port = Number(arg(rest, '--port', '8091'));
  const file = arg(rest, '--file', 'relay.log')!;
  const unsigned = rest.includes('--unsigned');
  const trustedDevices: Record<string, string> = {};
  for (const t of argAll(rest, '--trust')) {
    const eq = t.indexOf('=');
    if (eq < 0) die(`--trust wants id=pubkey-path, got: ${t}`);
    const id = t.slice(0, eq);
    if (!id) die(`--trust wants id=pubkey-path, got: ${t}`);
    try {
      trustedDevices[id] = readFileSync(t.slice(eq + 1), 'utf8').trim();
    } catch {
      die(`cannot read pubkey for --trust ${id}: ${t.slice(eq + 1)}`);
    }
  }
  if (Object.keys(trustedDevices).length === 0 && !unsigned) {
    die('serve needs --trust <id=pub.pem> or --unsigned for an open relay');
  }
  const server = new WsRelayServer({ port, file, trustedDevices, allowUnsigned: unsigned });
  const actual = await server.start();
  console.log(`fielog relay listening ws://127.0.0.1:${actual} file=${file}`);
  console.log(`ready port=${actual}`);
  const stop = () => {
    server.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // run until killed
}

async function cmdSync(rest: string[]): Promise<void> {
  const file = arg(rest, '--file');
  const relay = arg(rest, '--relay');
  if (!file || !relay) die(usage());
  const unsigned = rest.includes('--unsigned');
  const keyPath = arg(rest, '--key');
  const asId = arg(rest, '--as');
  if (!keyPath && !unsigned) die('sync needs --key <priv.pem> --as <device> or --unsigned for unsigned mode');
  if (keyPath && !asId) die('sync --key needs a matching --as <device>');
  const privateKeyPem = keyPath ? readFileSync(keyPath, 'utf8').trim() : undefined;
  const kernel = await createKernel({ file: file as string, deviceId: asId, privateKeyPem });
  const token = privateKeyPem ? kernel.capToken(privateKeyPem) : undefined;
  const client = new WsRelayClient(relay as string, token ? { capToken: token } : {});
  try {
    const r = await kernel.sync(client);
    console.log(`sync pushed=${r.pushed} acked=${r.acked} pulled=${r.pulled} applied=${r.applied}`);
  } finally {
    client.close();
    kernel.close();
  }
}

async function cmdDemo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fielog-demo-'));
  const k1 = generateDeviceKey('hp1');
  const k2 = generateDeviceKey('hp2');
  const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log'), trustedDevices: { hp1: k1.publicKeyPem, hp2: k2.publicKeyPem } });
  const port = await server.start();
  const hp1 = await createKernel({ file: join(dir, 'hp1.db'), deviceId: 'hp1', privateKeyPem: k1.privateKeyPem });
  const hp2 = await createKernel({ file: join(dir, 'hp2.db'), deviceId: 'hp2', privateKeyPem: k2.privateKeyPem });
  const c1 = new WsRelayClient(`ws://127.0.0.1:${port}`, { capToken: hp1.capToken(k1.privateKeyPem) });
  const c2 = new WsRelayClient(`ws://127.0.0.1:${port}`, { capToken: hp2.capToken(k2.privateKeyPem) });
  try {
    let expected = 0;
    for (let i = 0; i < 20; i++) {
      const nominal = 5000 + i * 250;
      expected += nominal;
      await hp1.append({ type: 'bayar', nominal, oleh: 'kasir-1' });
    }
    await hp1.sync(c1, { trustedDevices: { hp2: k2.publicKeyPem } });
    await hp2.sync(c2, { trustedDevices: { hp1: k1.publicKeyPem } });
    const t1 = await hp1.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    const t2 = await hp2.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    console.log(`sync: hp1 = ${t1[0].total} | hp2 = ${t2[0].total} | expected = ${expected}`);
    if (t1[0].total !== expected || t2[0].total !== expected) {
      console.error(`totals differ: hp1=${t1[0].total} hp2=${t2[0].total} expected=${expected}`);
      process.exit(1);
    }
    console.log('match on both sides, totals agree');
  } finally {
    c1.close();
    c2.close();
    hp1.close();
    hp2.close();
    server.kill();
  }
}

const [cmd, ...rest] = Bun.argv.slice(2);
if (cmd === 'serve') await cmdServe(rest);
else if (cmd === 'sync') await cmdSync(rest);
else if (cmd === 'demo') await cmdDemo();
else {
  console.error(usage());
  process.exit(2);
}
