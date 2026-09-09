// example/ledger.mjs — runs with: bun example/ledger.mjs
import { createKernel, MemoryRelay } from '../src/index.ts';
const k = await createKernel({ file: 'ledger.db' });
const tx = await k.append({ type: 'entry', value: 50000, actor: 'budi' });
console.log(await k.query('SELECT sum(value) AS total FROM entries WHERE voided = 0'));
// → [ { total: 50000 } ] — state is RECORDED (not paid), no network touched
await k.sync(new MemoryRelay()); // delta push/pull; pass your own Relay for wss
await k.undo(tx.id);
k.close();
