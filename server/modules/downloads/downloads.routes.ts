import { promises as fs } from 'node:fs';
import path from 'node:path';

import express, { type RequestHandler } from 'express';

import type { DownloadTicketStore } from '@/modules/downloads/download-tickets.js';

type DownloadsRouterDependencies = {
  authenticate: RequestHandler;
  tickets: DownloadTicketStore;
  toLocalPath: (claudePath: string) => string;
};

/**
 * Downloads any file on this machine by absolute path, in two steps so the JWT
 * never appears in a URL: an authenticated POST issues a one-time ticket, and
 * the browser fetches `GET /:ticket/:filename` as a plain link (streamed by the
 * browser's own download manager, so large files never sit in page memory).
 * Not limited to the project root: a signed-in user already has a full shell.
 */
export function createDownloadsRouter({ authenticate, tickets, toLocalPath }: DownloadsRouterDependencies) {
  const router = express.Router();

  router.post('/', authenticate, async (request, response) => {
    const requestedPath = (request.body as { path?: unknown } | undefined)?.path;
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
      return response.status(400).json({ error: 'path is required' });
    }

    const localPath = toLocalPath(requestedPath.trim());
    if (!path.posix.isAbsolute(localPath)) {
      return response.status(400).json({ error: 'path must be absolute' });
    }

    let isDirectory: boolean;
    try {
      isDirectory = (await fs.stat(localPath)).isDirectory();
    } catch {
      return response.status(404).json({ error: 'File not found' });
    }
    if (isDirectory) {
      return response.status(400).json({ error: 'Path is a directory, not a file' });
    }

    const ticket = tickets.issue(localPath);
    response.json({ url: `${request.baseUrl}/${ticket}/${encodeURIComponent(path.posix.basename(localPath))}` });
  });

  router.get('/:ticket/:filename?', (request, response) => {
    const localPath = tickets.redeem(request.params.ticket);
    if (!localPath) {
      return response.status(404).json({ error: 'Download link expired or already used' });
    }

    response.setHeader('X-Content-Type-Options', 'nosniff');
    // send() refuses any path with a dot segment by default, and Windows homes
    // are full of them (C:\Users\vital\.agentharbor\...).
    response.download(localPath, path.posix.basename(localPath), { dotfiles: 'allow' }, (error) => {
      if (error && !response.headersSent) {
        response.status(404).json({ error: 'File not found' });
      }
    });
  });

  return router;
}
