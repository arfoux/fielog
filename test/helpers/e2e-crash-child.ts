// e2e-crash-child.ts — appends the deterministic intent stream until SIGKILL.
// Usage: bun test/helpers/e2e-crash-child.ts <dir> <startIndex> <privFile> [maxCount]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKernel } from '../../src/kernel.ts';
import { intentFor } from '../e2e-intents.ts';

const dir = process.argv[2] ?? '';
const start = Number(process.argv[3] ?? '400');
const privFile = process.argv[4] ?? '';
const max = Number(process.argv[5] ?? '3000');
const priv = readFileSync(privFile, 'utf8');
const k = await createKernel({ file: join(dir, 'ledger.db'), deviceId: 'device-a', privateKeyPem: priv });
for (let i = start; i < start + max; i++) {
  await k.append(intentFor(i) as never);
}
k.close();
