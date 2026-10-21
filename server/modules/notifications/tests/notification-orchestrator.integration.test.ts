import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

test('a browser keeps its own notification categories, every one on until turned off', async () => {
  await withIsolatedDatabase(() => {
    const userId = Number(userDb.createUser('alice', 'hash').id);
    pushSubscriptionsDb.saveSubscription(userId, 'https://push.example.test/phone', 'key', 'auth');
    pushSubscriptionsDb.saveSubscription(userId, 'https://push.example.test/desktop', 'key', 'auth');

    assert.equal(pushSubscriptionsDb.setCategories(userId, 'https://push.example.test/desktop', {
      finished: false, waiting: true, agentMessage: false, system: true,
    }), true);
    assert.equal(pushSubscriptionsDb.setCategories(userId, 'https://push.example.test/unknown', {
      finished: true, waiting: true, agentMessage: true, system: true,
    }), false);

    const categoriesByEndpoint = Object.fromEntries(
      pushSubscriptionsDb.getSubscriptions(userId).map((subscription) => [subscription.endpoint, subscription.categories]),
    );
    assert.deepEqual(categoriesByEndpoint['https://push.example.test/phone'], {
      finished: true, waiting: true, agentMessage: true, system: true,
    });
    assert.equal(categoriesByEndpoint['https://push.example.test/desktop'].finished, false);
    assert.deepEqual(pushSubscriptionsDb.getSubscribedUserIds(), [userId]);
  });
});

test('a notification for a session AgentHarbor does not know opens no chat', async () => {
  await withIsolatedDatabase(() => {
    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'unregistered-claude-session',
      kind: 'agent_message',
      code: 'agent.notification',
      meta: { message: 'Build is green', sessionName: 'nightly' },
    });

    assert.equal(payload.data.sessionId, null);
    assert.equal(payload.title, 'nightly');
    assert.equal(payload.body, 'Build is green');
  });
});
