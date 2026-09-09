// example/ledger.mjs — runs with: bun example/ledger.mjs
import { createKernel, MemoryRelay } from '../src/index.ts';
const k = await createKernel({ file: 'ledger.db' });
const tx = await k.append({ type: 'payment', amount: 50000, actor: 'budi' });
console.log(await k.query('SELECT sum(amount) AS total FROM payment WHERE voided = 0'));
// → [ { total: 50000 } ] — state is IOU_RECORDED (not paid), no network touched
await k.sync(new MemoryRelay()); // delta push/pull; pass your own Relay for wss
await k.undo(tx.id);
k.close();
