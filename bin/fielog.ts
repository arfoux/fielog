#!/usr/bin/env bun
// bin/fielog.ts — cli kecil: serve relay ws, sync file kernel, demo kasir 2hp.
// bun only. contoh:
//   bun bin/fielog.ts serve --port 8091 --file ./relay.log
//   bun bin/fielog.ts sync --file ./kasir.db --relay ws://127.0.0.1:8091
//   bun bin/fielog.ts demo
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, WsRelayClient, WsRelayServer } from '../src/index.ts';

function usage(): string {
  return [
    'pakai: fielog <serve|sync|demo> [opsi]',
    '  serve --port <n> --file <relay.log>   jalan relay ws file-backed',
    '  sync --file <kasir.db> --relay <ws url> dorong+tari delta kernel',
    '  demo                                   kasir 2hp offline lalu sync, total sama',
  ].join('\n');
}

function arg(args: string[], name: string, def?: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return def;
  return args[i + 1] ?? def;
}

async function cmdServe(rest: string[]): Promise<void> {
  const port = Number(arg(rest, '--port', '8091'));
  const file = arg(rest, '--file', 'relay.log')!;
  const server = new WsRelayServer({ port, file });
  const actual = await server.start();
  console.log(`fielog relay listening ws://127.0.0.1:${actual} file=${file}`);
  console.log(`ready port=${actual}`);
  const stop = () => {
    server.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // hidup sampai dibunuh
}

async function cmdSync(rest: string[]): Promise<void> {
  const file = arg(rest, '--file');
  const relay = arg(rest, '--relay');
  if (!file || !relay) {
    console.error(usage());
    process.exit(2);
  }
  const kernel = await createKernel({ file });
  const client = new WsRelayClient(relay);
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
  const server = new WsRelayServer({ port: 0, file: join(dir, 'relay.log') });
  const port = await server.start();
  const hp1 = await createKernel({ file: join(dir, 'hp1.db') });
  const hp2 = await createKernel({ file: join(dir, 'hp2.db') });
  const c1 = new WsRelayClient(`ws://127.0.0.1:${port}`);
  const c2 = new WsRelayClient(`ws://127.0.0.1:${port}`);
  try {
    let expected = 0;
    for (let i = 0; i < 20; i++) {
      const nominal = 5000 + i * 250;
      expected += nominal;
      await hp1.append({ type: 'bayar', nominal, oleh: 'kasir-1' });
    }
    await hp1.sync(c1);
    await hp2.sync(c2);
    const t1 = await hp1.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    const t2 = await hp2.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
    console.log(`sync: hp1 = ${t1[0].total} | hp2 = ${t2[0].total} | mau = ${expected}`);
    if (t1[0].total !== expected || t2[0].total !== expected) {
      console.error(`total beda: hp1=${t1[0].total} hp2=${t2[0].total} mau=${expected}`);
      process.exit(1);
    }
    console.log('sama dua sisi, total cocok');
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
