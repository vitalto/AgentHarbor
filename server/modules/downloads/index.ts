// Router mounted at /api/downloads by server/index.ts: one-time download links for any file by absolute path.
import os from 'node:os';
import path from 'node:path';

import { authenticateToken } from '@/modules/auth/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { createDownloadTicketStore } from '@/modules/downloads/download-tickets.js';
import { createDownloadsRouter } from '@/modules/downloads/downloads.routes.js';
import { getAgentConfig, toLocalPath } from '@/modules/tmux/index.js';

/**
 * Claude keeps a session's scratchpad in `<temp>/claude/<project slug>/<session id>/scratchpad`,
 * where the slug is the folder name its transcripts live in. The Windows binary
 * uses the Windows temp folder, which this Linux server reaches beside its home.
 */
function claudeSessionTempDir(jsonlPath: string, providerSessionId: string): string {
  const config = getAgentConfig();
  const tempRoot = config.windowsClaude
    ? path.posix.join(path.posix.dirname(config.claudeHome), 'AppData/Local/Temp')
    : os.tmpdir();
  const projectSlug = path.posix.basename(path.posix.dirname(toLocalPath(jsonlPath)));
  return path.posix.join(tempRoot, 'claude', projectSlug, providerSessionId);
}

function findSessionRoots(sessionId: string): string[] {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return [];
  }
  const roots: string[] = [];
  if (session.project_path) {
    roots.push(toLocalPath(session.project_path));
  }
  if (session.jsonl_path && session.provider_session_id) {
    roots.push(claudeSessionTempDir(session.jsonl_path, session.provider_session_id));
  }
  return roots;
}

export const downloadsRoutes = createDownloadsRouter({
  authenticate: authenticateToken,
  tickets: createDownloadTicketStore(),
  toLocalPath: (claudePath) => toLocalPath(claudePath),
  findSessionRoots,
});
