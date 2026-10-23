import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { listPages, readConfig, readPageHtml, toLocalDirectory, writeConfig } from './pages-store.mjs';

// Outside the plugin folder, so a redeploy or reinstall keeps the settings.
const CONFIG_PATH = path.join(os.homedir(), '.agentharbor', 'plugin-data', 'pages', 'config.json');
const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('Request body is too large');
  }
  return body ? JSON.parse(body) : {};
}

async function handle(request) {
  const url = new URL(request.url, 'http://plugin');
  const config = await readConfig(CONFIG_PATH);
  const pagesDir = toLocalDirectory(config.pagesDir);

  if (url.pathname === '/config' && request.method === 'GET') {
    return { config };
  }
  if (url.pathname === '/config' && request.method === 'PUT') {
    return { config: await writeConfig(CONFIG_PATH, await readJsonBody(request)) };
  }
  if (url.pathname === '/pages' && request.method === 'GET') {
    try {
      return { config, pages: await listPages(pagesDir) };
    } catch (error) {
      if (error.code === 'ENOENT') return { config, pages: [], folderMissing: true };
      throw error;
    }
  }
  if (url.pathname === '/page' && request.method === 'GET') {
    return { html: await readPageHtml(pagesDir, url.searchParams.get('id') ?? '') };
  }
  return { error: `Unknown route ${request.method} ${url.pathname}` };
}

// The host turns any non-2xx answer into a bare "RPC error <status>", so
// failures travel as 200 + { error } to reach the tab with their message.
const server = http.createServer(async (request, response) => {
  let payload;
  try {
    payload = await handle(request);
  } catch (error) {
    payload = { error: error.message };
  }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: server.address().port }));
});
