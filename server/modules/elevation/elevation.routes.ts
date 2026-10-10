import express from 'express';

import { ElevationRequestNotFoundError, type ElevationQueue } from '@/modules/elevation/elevation-queue.service.js';

/** Used by the elevation module's barrel; mounted behind authentication at /api/elevation. */
export function createElevationRouter(queue: ElevationQueue) {
  const router = express.Router();

  // Express 4 does not catch rejected handlers, so each route answers its own failures.
  router.get('/', async (_request, response) => {
    try {
      response.json({ success: true, data: await queue.read() });
    } catch (error) {
      response.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  router.post('/:id/decision', async (request, response) => {
    const approved = (request.body as { approved?: unknown } | undefined)?.approved;
    if (typeof approved !== 'boolean') {
      return response.status(400).json({ success: false, error: 'approved must be true or false' });
    }
    try {
      await queue.decide(request.params.id, approved);
    } catch (error) {
      if (error instanceof ElevationRequestNotFoundError) {
        return response.status(404).json({ success: false, error: 'The request was already answered or the agent stopped waiting' });
      }
      return response.status(500).json({ success: false, error: (error as Error).message });
    }
    response.json({ success: true });
  });

  return router;
}
