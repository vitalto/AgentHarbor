// Router mounted at /api/downloads by server/index.ts: one-time download links for any file by absolute path.
import { authenticateToken } from '@/modules/auth/index.js';
import { createDownloadTicketStore } from '@/modules/downloads/download-tickets.js';
import { createDownloadsRouter } from '@/modules/downloads/downloads.routes.js';
import { toLocalPath } from '@/modules/tmux/index.js';

export const downloadsRoutes = createDownloadsRouter({
  authenticate: authenticateToken,
  tickets: createDownloadTicketStore(),
  toLocalPath: (claudePath) => toLocalPath(claudePath),
});
