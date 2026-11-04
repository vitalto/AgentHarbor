import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { isChatOnScreen } from '@/modules/notifications/services/chat-viewers.service.js';
import { categoryOfEventKind } from '@/shared/notification-categories.js';

const recentEventKeys = new Map();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isDuplicate(event) {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

/**
 * @param {{
 *   provider: string,
 *   sessionId?: string | null,
 *   kind?: string,
 *   code?: string,
 *   meta?: Record<string, unknown>,
 *   severity?: string,
 *   dedupeKey?: string | null,
 *   requiresUserAction?: boolean,
 * }} options
 */
function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}) {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName) {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row, provider) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId, provider) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row) {
    // No chat to open: e.g. an agent in a Windows console that AgentHarbor never registered.
    return { ...event, sessionId: null };
  }
  if (row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function buildNotificationPayload(event) {
  const normalizedEvent = normalizeNotificationSession(event);
  const CODE_MAP = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.background_completed': 'Background work finished',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'agent.finished': normalizedEvent.meta?.summary || 'Finished',
    'agent.waiting': normalizedEvent.meta?.question || 'Waiting for your answer',
    'agent.trust_folder': `Claude in ${normalizedEvent.meta?.folderName || 'this folder'} waits for you to trust the folder`
  };
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'AgentHarbor',
    body: message,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

/** The push service can hang through a flaky route; a delivery waits this long before it counts as failed. */
const PUSH_REQUEST_TIMEOUT_MS = 20_000;
/** One retry after a failure that is not a definitive "gone": timeouts, resets, 5xx and 429 are usually brief. */
const PUSH_RETRY_DELAY_MS = 5_000;

/**
 * FCM answered 410 for a phone's subscription that took pushes again hours later (2026-11-04), and
 * deleting it on that answer silenced every push until AgentHarbor was next opened on the phone.
 * So a "gone" answer only marks the subscription; it is deleted once deliveries kept failing that
 * way this long with the browser never re-sending it. A dead one costs one refused request per push.
 */
const GONE_SUBSCRIPTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Answers that say the browser dropped the subscription; anything else is a passing failure. */
function isSubscriptionGone(statusCode) {
  return statusCode === 404 || statusCode === 410;
}

function deliverPush(subscription, serializedPayload) {
  return webPush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys_p256dh,
        auth: subscription.keys_auth
      }
    },
    serializedPayload,
    { timeout: PUSH_REQUEST_TIMEOUT_MS }
  );
}

async function deliverPushWithRetry(subscription, serializedPayload) {
  try {
    await deliverPush(subscription, serializedPayload);
  } catch (error) {
    if (isSubscriptionGone(error?.statusCode)) {
      throw error;
    }
    console.warn('[AgentHarbor] push delivery failed, retrying once', error?.statusCode ?? '', error?.body ?? error?.message ?? error);
    await new Promise((resolve) => setTimeout(resolve, PUSH_RETRY_DELAY_MS));
    await deliverPush(subscription, serializedPayload);
  }
}

/** Sends to the user's browsers that take this category; resolves to how many were addressed. */
function sendWebPushPayload(userId, payload, category) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId)
    .filter((subscription) => subscription.categories[category]);
  if (!subscriptions.length) return Promise.resolve(0);

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((subscription) => deliverPushWithRetry(subscription, serializedPayload))
  ).then((results) => {
    const now = Date.now();
    results.forEach((result, index) => {
      const { endpoint } = subscriptions[index];
      if (result.status === 'fulfilled') {
        pushSubscriptionsDb.markDelivered(endpoint);
        return;
      }
      const statusCode = result.reason?.statusCode;
      if (isSubscriptionGone(statusCode)) {
        const goneSince = pushSubscriptionsDb.markGone(endpoint, now) ?? now;
        const shortEndpoint = `${endpoint.slice(0, 60)}...`;
        const answer = String(result.reason?.body ?? '').trim();
        if (now - goneSince >= GONE_SUBSCRIPTION_GRACE_MS) {
          console.warn(`[AgentHarbor] push service answered ${statusCode} for 7 days: dropping the subscription ${shortEndpoint}`, answer);
          pushSubscriptionsDb.removeSubscription(endpoint);
        } else {
          console.warn(`[AgentHarbor] push service answered ${statusCode}, subscription kept (gone since ${new Date(goneSince).toISOString()}) ${shortEndpoint}`, answer);
        }
      } else {
        console.error('[AgentHarbor] push delivery failed, subscription kept', statusCode ?? '', result.reason?.body ?? result.reason?.message ?? result.reason);
      }
    });
    return subscriptions.length;
  });
}

const notificationChannels = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload, category }) => sendWebPushPayload(userId, payload, category)
  }
];

/** Events whose content the chat itself shows as it happens: a finished turn, a question, a failure. */
const CHAT_CONTENT_EVENT_KINDS = new Set(['stop', 'action_required', 'error']);

/**
 * While some page of the user shows the event's chat, the push would only repeat it (on that
 * device or another). `ah notify` messages are not part of the chat and still go out.
 */
function repeatsWhatTheUserSees(userId, event) {
  return CHAT_CONTENT_EVENT_KINDS.has(event.kind)
    && Boolean(event.sessionId)
    && isChatOnScreen(Number(userId), event.sessionId);
}

/**
 * Delivers an event to every enabled channel; each subscribed browser filters
 * by its own categories. Resolves to how many devices were addressed.
 */
async function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) {
    return 0;
  }

  const normalizedEvent = normalizeNotificationSession(event);
  if (repeatsWhatTheUserSees(userId, normalizedEvent)) {
    return 0;
  }
  if (isDuplicate(normalizedEvent)) {
    return 0;
  }

  const preferences = notificationPreferencesDb.getPreferences(userId);
  const payload = buildNotificationPayload(normalizedEvent);
  const category = categoryOfEventKind(normalizedEvent.kind);
  let addressed = 0;
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    addressed += await Promise.resolve(channel.send({ userId, event: normalizedEvent, payload, category })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
      return 0;
    });
  }
  return addressed;
}

function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key collapses repeats inside the dedupe window.
 */
function notifyBackgroundWorkCompleted({ userId, provider, sessionId = null, sessionName = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info'
    })
  });
}

function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}

export {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed,
  notifyBackgroundWorkCompleted
};
