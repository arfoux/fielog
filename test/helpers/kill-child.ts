// Child for the kill9 test: appends as fast as fsync allows until SIGKILL.
// Usage: bun test/helpers/kill-child.ts <dir> [total]
import { createKernel } from '../../src/kernel.ts';

const dir = process.argv[2] ?? '';
const total = Number(process.argv[3] ?? '5000');
const k = await createKernel({ file: dir + '/kasir.db' });
for (let i = 0; i < total; i++) {
  await k.append({ type: 'bayar', nominal: 100 + (i % 997), oleh: 'kasir' });
}
k.close();
