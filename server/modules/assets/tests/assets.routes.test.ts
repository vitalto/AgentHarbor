import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import express from 'express';

import { assetsRoutes } from '@/modules/assets/index.js';

async function startAssetsServer(t: TestContext) {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-routes-'));
  t.mock.method(os, 'homedir', () => temporaryHome);
  const app = express();
  app.use('/api/assets', assetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await fs.rm(temporaryHome, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  return {
    assetsDir: path.join(temporaryHome, '.agentharbor', 'assets'),
    baseUrl: `http://127.0.0.1:${port}/api/assets`,
  };
}

test('a stored non-image attachment is served sandboxed, so uploaded HTML never runs in the app origin', async (t) => {
  const { assetsDir, baseUrl } = await startAssetsServer(t);
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(path.join(assetsDir, '1-page.html'), '<script>alert(1)</script>');
  const response = await fetch(`${baseUrl}/images/1-page.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), '<script>alert(1)</script>');
});

test('long Unicode filenames round-trip through both upload routes with their original display names', async (t) => {
  const { baseUrl } = await startAssetsServer(t);
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const cases = [
    { field: 'files', key: 'attachments', type: docx, name: `Придобиване на българско гражданство... ${'български гражданин '.repeat(10)}чл. 15 от ЗБГ.docx` },
    { field: 'images', key: 'images', type: 'image/png', name: `${'𐐷'.repeat(75)}.png` },
  ];
  for (const { field, key, type, name } of cases) {
    const data = new FormData();
    data.append(field, new Blob(['upload bytes'], { type }), name);
    const upload = await fetch(`${baseUrl}/${field}`, { method: 'POST', body: data });
    assert.equal(upload.status, 200);
    const result = await upload.json() as Record<string, { name: string; path: string }[]>;
    const [stored] = result[key];
    assert.equal(stored.name, name);
    const storedName = path.basename(stored.path);
    assert.ok(Buffer.byteLength(storedName) <= 255);
    assert.equal(path.extname(storedName), path.extname(name));
    const download = await fetch(`${baseUrl}/images/${encodeURIComponent(storedName)}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), type);
    assert.equal(await download.text(), 'upload bytes');
  }
});
