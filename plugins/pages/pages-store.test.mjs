import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  extractPageInfo,
  listPages,
  normalizePagesUrl,
  readConfig,
  readPageHtml,
  toLocalDirectory,
  writeConfig,
} from './pages-store.mjs';

let pagesDir;

before(async () => {
  pagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ahp-test-'));
  await fs.mkdir(path.join(pagesDir, 'older-report'));
  await fs.writeFile(path.join(pagesDir, 'older-report', 'index.html'), '<title>Old &amp; tired</title>');
  await fs.mkdir(path.join(pagesDir, 'dashboard'));
  await fs.writeFile(path.join(pagesDir, 'dashboard', 'index.html'),
    '<head><title>\n  Flight   watch\n</title><meta name="description" content="Prices &quot;today&quot;"></head>');
  await fs.mkdir(path.join(pagesDir, 'no-index'));
  await fs.writeFile(path.join(pagesDir, 'no-index', 'notes.txt'), 'x');
  await fs.writeFile(path.join(pagesDir, 'single.html'), '<p>no title</p>');
  await fs.writeFile(path.join(pagesDir, 'index.html'), '<title>Hub</title>');
  await fs.mkdir(path.join(pagesDir, '.hidden'));
  await fs.writeFile(path.join(pagesDir, '.hidden', 'index.html'), '<title>Hidden</title>');

  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 86400_000);
  await fs.utimes(path.join(pagesDir, 'older-report', 'index.html'), dayAgo, dayAgo);
  await fs.utimes(path.join(pagesDir, 'single.html'), hourAgo, hourAgo);
  await fs.utimes(path.join(pagesDir, 'dashboard', 'index.html'), dayAgo, dayAgo);
  await fs.writeFile(path.join(pagesDir, 'dashboard', 'data.json'), '{}');
});

after(async () => {
  await fs.rm(pagesDir, { recursive: true, force: true });
});

test('lists folders with an index.html and loose html files, newest first, without the hub page', async () => {
  const pages = await listPages(pagesDir);
  assert.deepEqual(pages.map((page) => page.id), ['dashboard/', 'single.html', 'older-report/']);
  assert.equal(pages[0].title, 'Flight watch');
  assert.equal(pages[0].description, 'Prices "today"');
  assert.equal(pages[1].name, 'single');
  assert.equal(pages[1].title, '');
  assert.equal(pages[2].title, 'Old & tired');
});

test('a folder counts as updated when any of its files changes', async () => {
  const [dashboard] = await listPages(pagesDir);
  assert.ok(Date.now() - new Date(dashboard.modifiedAt).getTime() < 60_000);
});

test('serves only listed pages', async () => {
  assert.match(await readPageHtml(pagesDir, 'dashboard/'), /Flight/);
  assert.match(await readPageHtml(pagesDir, 'single.html'), /no title/);
  await assert.rejects(readPageHtml(pagesDir, '../etc/passwd'), /Page not found/);
  await assert.rejects(readPageHtml(pagesDir, 'index.html'), /Page not found/);
  await assert.rejects(readPageHtml(pagesDir, '.hidden/'), /Page not found/);
});

test('maps Windows paths to WSL mounts outside Windows', () => {
  assert.equal(toLocalDirectory('C:\\Users\\me\\Documents\\pages', 'linux'), '/mnt/c/Users/me/Documents/pages');
  assert.equal(toLocalDirectory('D:/Reports', 'linux'), '/mnt/d/Reports');
  assert.equal(toLocalDirectory('C:\\Users\\me', 'win32'), 'C:\\Users\\me');
  assert.equal(toLocalDirectory('/srv/pages', 'linux'), '/srv/pages');
  assert.equal(toLocalDirectory('~/pages', 'linux'), path.join(os.homedir(), 'pages'));
});

test('normalizes the pages url', () => {
  assert.equal(normalizePagesUrl(' http://10.0.0.5:8088/ '), 'http://10.0.0.5:8088');
  assert.equal(normalizePagesUrl(''), '');
  assert.throws(() => normalizePagesUrl('file:///etc'), /http/);
  assert.throws(() => normalizePagesUrl('not a url'), /valid URL/);
});

test('extracts nothing from a page without title or description', () => {
  assert.deepEqual(extractPageInfo('<p>x</p>'), { title: '', description: '' });
});

test('config round-trips and falls back to defaults', async () => {
  const configPath = path.join(pagesDir, 'plugin-data', 'config.json');
  assert.equal((await readConfig(configPath)).pagesUrl, '');
  await writeConfig(configPath, { pagesDir: ' C:\\pages ', pagesUrl: 'http://host:1/' });
  assert.deepEqual(await readConfig(configPath), { pagesDir: 'C:\\pages', pagesUrl: 'http://host:1' });
  await assert.rejects(writeConfig(configPath, { pagesDir: ' ' }), /required/);
});
