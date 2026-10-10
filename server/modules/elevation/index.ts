// Router mounted at /api/elevation by server/index.ts: lists the commands agents asked to run
// elevated and records the user's approval for the Windows elevation broker.
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { createElevationQueue } from '@/modules/elevation/elevation-queue.service.js';
import { createElevationRouter } from '@/modules/elevation/elevation.routes.js';
import { getAgentConfig, readClaudeProcesses } from '@/modules/tmux/index.js';

const queue = createElevationQueue({
  queueDir: path.join(getAgentConfig().stateDir, 'elevation'),
  findSessionByClaudePid: async (claudePid) => {
    const claude = (await readClaudeProcesses()).find((candidate) => candidate.pid === claudePid);
    const row = claude ? sessionsDb.getSessionByProviderSessionId(claude.providerSessionId) : null;
    return row ? { sessionId: row.session_id, title: row.custom_name || null } : null;
  },
});

export const elevationRoutes = createElevationRouter(queue);
