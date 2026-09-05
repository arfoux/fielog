// Trusted-mode source signing: kernel appends carry a device signature, so
// receivers with a trustedDevices registry apply (not dead-letter)
// legitimate traffic. Regression: unsigned kernel appends pulled under a
// registry came back pulled=1 applied=0 while the cursor advanced.
import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel, logPathFor } from '../src/kernel.ts';
import { MemoryRelay } from '../src/sync.ts';
import { generateDeviceKey } from '../src/auth.ts';

const fast = { baseMs: 1, maxMs: 30 };

describe('trusted-mode source signing', () => {
  it('signed kernel appends apply under a trusted registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fielog-trustedsign-'));
    const a = generateDeviceKey('kasir-a');
    const b = generateDeviceKey('kasir-b');
    const registry = new Map([
      [a.deviceId, a.publicKeyPem],
      [b.deviceId, b.publicKeyPem],
    ]);
    const ka = await createKernel({ file: join(dir, 'a.db'), deviceId: a.deviceId, privateKeyPem: a.privateKeyPem });
    const kb = await createKernel({ file: join(dir, 'b.db'), deviceId: b.deviceId, privateKeyPem: b.privateKeyPem });
    try {
      await ka.append({ type: 'bayar', nominal: 7500, oleh: 'kasir-1' });
      // Signature is on disk before any sync: the relayed copy is verifiable.
      const line = readFileSync(logPathFor(join(dir, 'a.db')), 'utf8').trim();
      const stored = JSON.parse(line) as { signature?: string };
      assert.ok(typeof stored.signature === 'string' && stored.signature.length > 0);

      const relay = new MemoryRelay();
      const up = await ka.sync(relay, { ...fast });
      assert.equal(up.acked, 1);
      const down = await kb.sync(relay, { ...fast, trustedDevices: registry });
      assert.equal(down.pulled, 1);
      assert.equal(down.applied, 1);
      const rows = await kb.query<{ total: number }>(`SELECT SUM(nominal) AS total FROM bayar WHERE voided = 0`);
      assert.equal(rows[0].total, 7500);
    } finally {
      ka.close();
      kb.close();
    }
  }, 30_000);
});
