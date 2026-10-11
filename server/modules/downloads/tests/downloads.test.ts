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
    findSessionRoots: (sessionId) => (sessionId === 's1'
      ? [path.join(fixtureDir, 'project'), path.join(fixtureDir, 'temp', 'claude', 'slug', 'sid')]
      : []),
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

const resolvePaths = async (baseUrl: string, paths: string[], sessionId?: string) => {
  const response = await fetch(`${baseUrl}/api/downloads/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer valid' },
    body: JSON.stringify({ sessionId, paths }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { resolved: Record<string, string | null> }).resolved;
};

test('relative and ellipsis-shortened paths resolve under the project, then the session temp folder', async () => {
  await withDownloadsServer(async (baseUrl, fixtureDir) => {
    const project = path.join(fixtureDir, 'project');
    const scratchpad = path.join(fixtureDir, 'temp', 'claude', 'slug', 'sid', 'scratchpad');
    await mkdir(path.join(project, 'docs', 'guides'), { recursive: true });
    await mkdir(path.join(scratchpad, 'icon'), { recursive: true });
    await writeFile(path.join(project, 'docs', 'guides', 'playtest.md'), '# x');
    await writeFile(path.join(scratchpad, 'exe_icon.png'), 'png');
    await writeFile(path.join(scratchpad, 'icon', 'sheet.png'), 'png');

    const resolved = await resolvePaths(baseUrl, [
      'docs/guides/playtest.md',
      'docs\\guides\\playtest.md',
      './docs/guides/playtest.md',
      '…\\scratchpad\\exe_icon.png',
      '.../scratchpad/icon/sheet.png',
      'X:/project/docs/guides/playtest.md',
      'docs/guides',
      'missing.md',
    ], 's1');

    const playtest = path.join(project, 'docs', 'guides', 'playtest.md');
    assert.deepEqual(resolved, {
      'docs/guides/playtest.md': playtest,
      'docs\\guides\\playtest.md': playtest,
      './docs/guides/playtest.md': playtest,
      '…\\scratchpad\\exe_icon.png': path.join(scratchpad, 'exe_icon.png'),
      '.../scratchpad/icon/sheet.png': path.join(scratchpad, 'icon', 'sheet.png'),
      'X:/project/docs/guides/playtest.md': playtest,
      'docs/guides': null,
      'missing.md': null,
    });

    assert.deepEqual(await resolvePaths(baseUrl, ['docs/guides/playtest.md']), { 'docs/guides/playtest.md': null });
  });
});

test('preview content is served inline to an authenticated request only', async () => {
  await withDownloadsServer(async (baseUrl, fixtureDir) => {
    await writeFile(path.join(fixtureDir, 'shot.png'), 'PNG BYTES');
    const contentUrl = `${baseUrl}/api/downloads/content?path=${encodeURIComponent('X:/shot.png')}`;

    assert.equal((await fetch(contentUrl)).status, 401);
    const content = await fetch(contentUrl, { headers: { authorization: 'Bearer valid' } });
    assert.equal(content.status, 200);
    assert.equal(await content.text(), 'PNG BYTES');
    assert.equal(content.headers.get('content-type'), 'image/png');
    assert.equal(content.headers.get('content-disposition'), null);
    assert.equal(content.headers.get('content-security-policy'), 'sandbox');

    const missing = await fetch(`${baseUrl}/api/downloads/content?path=X:/nope.png`, { headers: { authorization: 'Bearer valid' } });
    assert.equal(missing.status, 404);
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
