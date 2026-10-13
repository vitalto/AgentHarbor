import express from 'express';

import type { ShutdownWhenIdle } from '@/modules/power/shutdown-when-idle.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number | null {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  return Number.isInteger(userId) ? userId : null;
}

/** Used by the power module's barrel; mounted behind authentication at /api/power. */
export function createPowerRouter<TAgent>(shutdownWhenIdle: ShutdownWhenIdle<TAgent>): express.Router {
  const router = express.Router();

  router.get('/shutdown-when-idle', (_request, response) => {
    response.json(createApiSuccessResponse(shutdownWhenIdle.getState()));
  });

  router.put('/shutdown-when-idle', asyncHandler(async (request, response) => {
    const armed = (request.body as { armed?: unknown } | undefined)?.armed;
    if (typeof armed !== 'boolean') {
      throw new AppError('armed must be true or false.', { code: 'INVALID_SHUTDOWN_WHEN_IDLE', statusCode: 400 });
    }
    const state = armed ? await shutdownWhenIdle.arm(readUserId(request)) : shutdownWhenIdle.disarm();
    response.json(createApiSuccessResponse(state));
  }));

  router.post('/shutdown-when-idle/cancel', asyncHandler(async (_request, response) => {
    response.json(createApiSuccessResponse(await shutdownWhenIdle.cancelShutdown()));
  }));

  return router;
}
