// Router mounted at /api/elevation by server/index.ts: lists the commands agents asked to run
// elevated and records the user's approval for the Windows elevation broker.
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { createElevationQueue } from '@/modules/elevation/elevation-queue.service.js';
import { createElevationRouter } from '@/modules/elevation/elevation.routes.js';
import { getAgentConfig } from '@/modules/tmux/index.js';

const queue = createElevationQueue({
  queueDir: path.join(getAgentConfig().stateDir, 'elevation'),
  findSession: (providerSessionId) => {
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    return row ? { sessionId: row.session_id, title: row.custom_name || null } : null;
  },
});

export const elevationRoutes = createElevationRouter(queue);
