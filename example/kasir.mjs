// example/kasir.mjs — runs with: bun example/kasir.mjs
import { createKernel, MemoryRelay } from '../src/index.ts';
const k = await createKernel({ file: 'kasir.db' });
const tx = await k.append({ type: 'bayar', nominal: 50000, oleh: 'budi' });
console.log(await k.query('SELECT sum(nominal) AS total FROM bayar WHERE voided = 0'));
// → [ { total: 50000 } ] — state is IOU_RECORDED (not paid), no network touched
await k.sync(new MemoryRelay()); // delta push/pull; pass your own Relay for wss
await k.undo(tx.id);
k.close();
