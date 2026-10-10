import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createDownloadTicketStore } from '@/modules/downloads/download-tickets.js';
import { createDownloadsRouter } from '@/modules/downloads/downloads.routes.js';

const rejectWithoutBearer: RequestHandler = (request, response, next) => {
  if (request.headers.authorization !== 'Bearer valid') {
    response.status(401).json({ error: 'Access denied' });
    return;
  }
  next();
};

async function withDownloadsServer(run: (baseUrl: string, fixtureDir: string) => Promise<void>) {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'ah-downloads-'));
  const app = express();
  app.use(express.json());
  app.use('/api/downloads', createDownloadsRouter({
    authenticate: rejectWithoutBearer,
    tickets: createDownloadTicketStore(),
    toLocalPath: (claudePath) => claudePath.replace(/^X:/, fixtureDir),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, fixtureDir);
  } finally {
    server.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

const issueTicket = (baseUrl: string, requestedPath: string, authorization = 'Bearer valid') =>
  fetch(`${baseUrl}/api/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization },
    body: JSON.stringify({ path: requestedPath }),
  });

test('a ticket downloads the file once as an attachment, then stops working', async () => {
  await withDownloadsServer(async (baseUrl, fixtureDir) => {
    await mkdir(path.join(fixtureDir, '.hidden dir'));
    await writeFile(path.join(fixtureDir, '.hidden dir', 'отчёт 1.pdf'), 'PDF BYTES');

    const issued = await issueTicket(baseUrl, 'X:/.hidden dir/отчёт 1.pdf');
    assert.equal(issued.status, 200);
    const { url } = await issued.json() as { url: string };
    assert.match(url, /^\/api\/downloads\/[\w-]{32}\/%D0%BE/);

    const download = await fetch(`${baseUrl}${url}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'PDF BYTES');
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; .*filename\*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%201\.pdf/);

    const reuse = await fetch(`${baseUrl}${url}`);
    assert.equal(reuse.status, 404);
  });
});

test('issuing a ticket requires authentication, an existing file and not a directory', async () => {
  await withDownloadsServer(async (baseUrl, fixtureDir) => {
    await writeFile(path.join(fixtureDir, 'a.txt'), 'a');

    assert.equal((await issueTicket(baseUrl, 'X:/a.txt', 'Bearer stolen')).status, 401);
    assert.equal((await issueTicket(baseUrl, 'X:/missing.txt')).status, 404);
    assert.equal((await issueTicket(baseUrl, 'X:/')).status, 400);
    assert.equal((await issueTicket(baseUrl, 'relative/a.txt')).status, 400);
  });
});

test('an unknown ticket is refused', async () => {
  await withDownloadsServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/downloads/not-a-ticket/a.txt`)).status, 404);
  });
});

test('a ticket expires after its lifetime', () => {
  let currentTime = 1_000;
  const tickets = createDownloadTicketStore({ lifetimeMs: 100, now: () => currentTime });
  const ticket = tickets.issue('/tmp/a.txt');
  currentTime += 100;
  assert.equal(tickets.redeem(ticket), null);
});
