import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { assetsRoutes } from '@/modules/assets/index.js';

test('a stored non-image attachment is served sandboxed, so uploaded HTML never runs in the app origin', async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-routes-'));
  const originalHome = process.env.HOME;
  process.env.HOME = temporaryHome;
  const app = express();
  app.use('/api/assets', assetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const assetsDir = path.join(temporaryHome, '.agentharbor', 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, '1-page.html'), '<script>alert(1)</script>');

    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/assets/images/1-page.html`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), '<script>alert(1)</script>');
  } finally {
    server.close();
    process.env.HOME = originalHome;
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});
