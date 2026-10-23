import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TITLE_SCAN_BYTES = 16 * 1024;
const HUB_PAGE = 'index.html';

export const DEFAULT_CONFIG = Object.freeze({
  pagesDir: path.join(os.homedir(), 'Documents', 'pages'),
  pagesUrl: '',
});

/**
 * AgentHarbor's server usually runs inside WSL while people think in Windows
 * paths, so `C:\Users\me\pages` has to become `/mnt/c/Users/me/pages` there.
 */
export function toLocalDirectory(input, platform = process.platform) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  const windowsDrive = /^([a-zA-Z]):[\\/](.*)$/.exec(trimmed);
  if (windowsDrive && platform !== 'win32') {
    const rest = windowsDrive[2].replace(/\\/g, '/');
    return path.posix.join('/mnt', windowsDrive[1].toLowerCase(), rest);
  }
  return trimmed;
}

export function normalizePagesUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The pages URL must start with http:// or https://');
  }
  return url.toString().replace(/\/+$/, '');
}

export async function readConfig(configPath) {
  try {
    const stored = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return { ...DEFAULT_CONFIG, ...stored };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(configPath, input) {
  const config = {
    pagesDir: String(input?.pagesDir ?? '').trim(),
    pagesUrl: normalizePagesUrl(input?.pagesUrl),
  };
  if (!config.pagesDir) throw new Error('The pages folder is required');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cleanText(raw) {
  return decodeHtmlEntities(raw.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export function extractPageInfo(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description = /<meta\s[^>]*name=["']description["'][^>]*>/i.exec(html)?.[0];
  const descriptionContent = description && /content=["']([^"']*)["']/i.exec(description)?.[1];
  return {
    title: title ? cleanText(title) : '',
    description: descriptionContent ? cleanText(descriptionContent) : '',
  };
}

async function readHead(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(TITLE_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TITLE_SCAN_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** A dashboard refreshed by a job rewrites its data file, not its index.html. */
async function newestModificationMs(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const stats = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map((entry) => fs.stat(path.join(directory, entry.name)).catch(() => null)));
  return Math.max(0, ...stats.filter(Boolean).map((stat) => stat.mtimeMs));
}

async function describePage(pagesDir, entry) {
  if (entry.isDirectory()) {
    const directory = path.join(pagesDir, entry.name);
    const indexFile = path.join(directory, HUB_PAGE);
    try {
      await fs.access(indexFile);
    } catch {
      return null;
    }
    return {
      id: `${entry.name}/`,
      name: entry.name,
      ...extractPageInfo(await readHead(indexFile)),
      modifiedAt: new Date(await newestModificationMs(directory)).toISOString(),
    };
  }
  if (entry.isFile() && /\.html?$/i.test(entry.name) && entry.name.toLowerCase() !== HUB_PAGE) {
    const file = path.join(pagesDir, entry.name);
    const stat = await fs.stat(file);
    return {
      id: entry.name,
      name: entry.name.replace(/\.html?$/i, ''),
      ...extractPageInfo(await readHead(file)),
      modifiedAt: stat.mtime.toISOString(),
    };
  }
  return null;
}

export async function listPages(pagesDir) {
  const entries = await fs.readdir(pagesDir, { withFileTypes: true });
  const pages = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => describePage(pagesDir, entry).catch(() => null)));
  return pages
    .filter(Boolean)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Only ids produced by listPages are served, so a crafted id cannot leave the folder. */
export async function readPageHtml(pagesDir, pageId) {
  const pages = await listPages(pagesDir);
  if (!pages.some((page) => page.id === pageId)) throw new Error('Page not found');
  const file = pageId.endsWith('/')
    ? path.join(pagesDir, pageId, HUB_PAGE)
    : path.join(pagesDir, pageId);
  return fs.readFile(file, 'utf8');
}
