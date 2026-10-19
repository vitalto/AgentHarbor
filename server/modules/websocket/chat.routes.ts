import express from 'express';

import {
  sendWithoutSocket,
  type ChatWebSocketDependencies,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

const STATUS_BY_ERROR_CODE: Record<string, number> = {
  SESSION_NOT_FOUND: 404,
  RUN_IN_PROGRESS: 409,
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Mounted behind authentication at /api/chat: the chat gateway for callers without a websocket. */
export function createChatRouter(dependencies: ChatWebSocketDependencies): express.Router {
  const router = express.Router();

  router.post('/sessions/:sessionId/messages', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const content = readOptionalString(body.content);
    if (!content) {
      throw new AppError('content must be a non-empty string.', { code: 'CONTENT_REQUIRED', statusCode: 400 });
    }

    const result = await sendWithoutSocket(
      (request as AuthenticatedRequest).user?.id ?? null,
      {
        sessionId: request.params.sessionId,
        content,
        options: { model: readOptionalString(body.model), effort: readOptionalString(body.effort) },
      },
      dependencies,
    );
    if ('code' in result) {
      throw new AppError(result.error, { code: result.code, statusCode: STATUS_BY_ERROR_CODE[result.code] ?? 400 });
    }
    response.status(202).json(createApiSuccessResponse(result));
  }));

  return router;
}
