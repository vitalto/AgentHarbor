import express from 'express';

import { notificationChannelEndpointsDb, notificationPreferencesDb } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/services/notification-orchestrator.service.js';

const router = express.Router();

const MAX_AGENT_MESSAGE_CHARS = 500;
const MAX_AGENT_TITLE_CHARS = 80;

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeEndpoint(endpoint: any) {
  return {
    id: endpoint.id,
    channel: endpoint.channel,
    endpointId: endpoint.endpoint_id,
    label: endpoint.label,
    metadata: notificationChannelEndpointsDb.parseMetadata(endpoint.metadata_json),
    enabled: Boolean(endpoint.enabled),
    lastSeenAt: endpoint.last_seen_at,
    createdAt: endpoint.created_at,
    updatedAt: endpoint.updated_at,
  };
}

function readUserId(req: express.Request): number {
  const userId = Number((req as any).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Authenticated user is missing');
  }
  return userId;
}

function updateChannelPreference(userId: number, channel: string): unknown {
  const currentPrefs = notificationPreferencesDb.getPreferences(userId);
  const hasEnabledEndpoint = notificationChannelEndpointsDb.getEnabledEndpoints(userId, channel).length > 0;
  return notificationPreferencesDb.updatePreferences(userId, {
    ...currentPrefs,
    channels: { ...currentPrefs.channels, [channel]: hasEnabledEndpoint },
  });
}

/**
 * An agent (or any API key holder) notifies the user's subscribed browsers.
 * `sessionId` may be the app or the Claude session id; with it the
 * notification is titled after that chat and opens it.
 */
router.post('/send', async (req, res) => {
  try {
    const message = readText(req.body?.message).slice(0, MAX_AGENT_MESSAGE_CHARS);
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    const title = readText(req.body?.title).slice(0, MAX_AGENT_TITLE_CHARS) || null;
    const sessionId = readText(req.body?.sessionId) || null;

    const devices = await notifyUserIfEnabled({
      userId: readUserId(req),
      event: createNotificationEvent({
        provider: sessionId ? 'claude' : 'system',
        sessionId,
        kind: 'agent_message',
        code: 'agent.notification',
        meta: { message, sessionName: title },
        // Every send is deliberate: a repeat is a new message, not a duplicate to drop.
        dedupeKey: `agent-message:${sessionId ?? 'none'}:${Date.now()}:${Math.random()}`,
      }),
    });
    return res.json({ success: true, devices });
  } catch (error) {
    console.error('Error sending an agent notification:', error);
    return res.status(500).json({ error: 'Failed to send the notification' });
  }
});

router.get('/endpoints', (req, res) => {
  try {
    const channel = readText(req.query.channel);
    if (!channel) {
      return res.status(400).json({ error: 'channel is required' });
    }

    const userId = readUserId(req);
    const endpoints = notificationChannelEndpointsDb
      .getEndpoints(userId, channel)
      .map(sanitizeEndpoint);
    return res.json({ success: true, endpoints });
  } catch (error) {
    console.error('Error fetching notification endpoints:', error);
    return res.status(500).json({ error: 'Failed to fetch notification endpoints' });
  }
});

router.post('/endpoints/current', (req, res) => {
  try {
    const { channel, endpointId, label, metadata = {}, enabled = true } = req.body || {};
    const normalizedChannel = readText(channel);
    const normalizedEndpointId = readText(endpointId);
    if (!normalizedChannel || !normalizedEndpointId) {
      return res.status(400).json({ error: 'channel and endpointId are required' });
    }

    const userId = readUserId(req);
    const endpoint = notificationChannelEndpointsDb.upsertEndpoint({
      userId,
      channel: normalizedChannel,
      endpointId: normalizedEndpointId,
      label,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      enabled: enabled !== false,
    });

    const preferences = updateChannelPreference(userId, normalizedChannel);
    return res.json({ success: true, endpoint: sanitizeEndpoint(endpoint), preferences });
  } catch (error) {
    console.error('Error registering notification endpoint:', error);
    return res.status(500).json({ error: 'Failed to register notification endpoint' });
  }
});

router.patch('/endpoints/:channel/:endpointId', (req, res) => {
  try {
    const { channel, endpointId } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const userId = readUserId(req);
    const updated = notificationChannelEndpointsDb.setEndpointEnabled(userId, channel, endpointId, enabled);
    if (!updated) {
      return res.status(404).json({ error: 'Notification endpoint not found' });
    }

    const endpoint = notificationChannelEndpointsDb.getEndpoint(userId, channel, endpointId);
    const preferences = updateChannelPreference(userId, channel);
    return res.json({ success: true, endpoint: endpoint ? sanitizeEndpoint(endpoint) : null, preferences });
  } catch (error) {
    console.error('Error updating notification endpoint:', error);
    return res.status(500).json({ error: 'Failed to update notification endpoint' });
  }
});

router.delete('/endpoints/:channel/:endpointId', (req, res) => {
  try {
    const { channel, endpointId } = req.params;
    const userId = readUserId(req);
    const removed = notificationChannelEndpointsDb.removeEndpoint(userId, channel, endpointId);
    if (!removed) {
      return res.status(404).json({ error: 'Notification endpoint not found' });
    }

    const preferences = updateChannelPreference(userId, channel);
    return res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error removing notification endpoint:', error);
    return res.status(500).json({ error: 'Failed to remove notification endpoint' });
  }
});

export default router;
