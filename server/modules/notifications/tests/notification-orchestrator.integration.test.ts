import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// @ts-expect-error -- web-push ships no type declarations (see vapid-keys.service.ts).
import webPush from 'web-push';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { categoryOfEventKind } from '@/shared/notification-categories.js';

import { folderTrustNotificationEvent } from '../services/agent-activity-notifier.service.js';
import {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
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

test('a start waiting on the folder-trust dialog pushes a question that opens its chat', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('starting-session', 'claude', '/mnt/d/Develop/Cloned', 'Fix the build');

    const event = folderTrustNotificationEvent({ appSessionId: 'starting-session', folder: 'D:\\Develop\\Cloned' }, 'Fix the build');
    const payload = buildNotificationPayload(event);

    assert.equal(categoryOfEventKind(event.kind), 'waiting', 'rides the "waiting on a question" preference');
    assert.equal(payload.data.sessionId, 'starting-session');
    assert.equal(payload.title, 'Fix the build');
    assert.equal(payload.body, 'Claude in Cloned waits for you to trust the folder');
  });
});

test('an untitled start waiting on the folder-trust dialog is named by its folder', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('untitled-session', 'claude', '/work/cloned');

    const payload = buildNotificationPayload(folderTrustNotificationEvent({ appSessionId: 'untitled-session', folder: '/work/cloned/' }, null));

    assert.equal(payload.title, 'cloned');
    assert.equal(payload.body, 'Claude in cloned waits for you to trust the folder');
  });
});

/** A user with one subscribed browser and Web Push on, as after "Enable" in Settings. */
function subscribedUser(name: string, endpoint: string): number {
  const userId = Number(userDb.createUser(name, 'hash').id);
  pushSubscriptionsDb.saveSubscription(userId, endpoint, 'key', 'auth');
  notificationPreferencesDb.updatePreferences(userId, { channels: { webPush: true } });
  return userId;
}

/** Lets the delivery's awaits run between fake-timer ticks (the retry waits on a timer). */
async function settleDelivery(t: test.TestContext, delivery: Promise<unknown>): Promise<void> {
  let done = false;
  void delivery.finally(() => { done = true; });
  for (let round = 0; round < 50 && !done; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5_000);
  }
  await delivery;
}

const pushError = (statusCode: number | undefined, message = 'push failed') => Object.assign(new Error(message), { statusCode, body: message });
const agentMessage = (message: string) => createNotificationEvent({ provider: 'system', code: 'agent.notification', meta: { message }, dedupeKey: `test:${message}` });

test('a browser the push service calls gone (410 or 404) is dropped', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  await withIsolatedDatabase(async () => {
    for (const [index, statusCode] of [410, 404].entries()) {
      const userId = subscribedUser(`gone${index}`, `https://push.example.test/gone-${statusCode}`);
      t.mock.method(webPush, 'sendNotification', async () => { throw pushError(statusCode); });

      await notifyUserIfEnabled({ userId, event: agentMessage(`gone ${statusCode}`) });
      assert.deepEqual(pushSubscriptionsDb.getSubscriptions(userId), [], String(statusCode));
    }
  });
});

test('a timeout, reset, 5xx or 429 keeps the subscription and is retried once', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withIsolatedDatabase(async () => {
    const failures = [pushError(undefined, 'ETIMEDOUT'), pushError(502), pushError(429)];
    for (const [index, failure] of failures.entries()) {
      const endpoint = `https://push.example.test/flaky-${index}`;
      const userId = subscribedUser(`flaky${index}`, endpoint);
      let attempts = 0;
      t.mock.method(webPush, 'sendNotification', async () => {
        attempts += 1;
        throw failure;
      });

      await settleDelivery(t, notifyUserIfEnabled({ userId, event: agentMessage(`flaky ${index}`) }));
      assert.equal(attempts, 2, `${failure.message}: one retry`);
      assert.deepEqual(pushSubscriptionsDb.getSubscriptions(userId).map((subscription) => subscription.endpoint), [endpoint], failure.message);
    }
  });
});

test('a delivery that goes through on the retry counts the browser as reached', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withIsolatedDatabase(async () => {
    const userId = subscribedUser('retry', 'https://push.example.test/retry');
    let attempts = 0;
    t.mock.method(webPush, 'sendNotification', async () => {
      attempts += 1;
      if (attempts === 1) {
        throw pushError(undefined, 'ECONNRESET');
      }
      return { statusCode: 201 };
    });

    const delivery = notifyUserIfEnabled({ userId, event: agentMessage('retry') });
    await settleDelivery(t, delivery);
    assert.equal(await delivery, 1);
    assert.equal(attempts, 2);
  });
});

test('a page re-sending its subscription keeps the browser, its categories and its user, and is not new', async () => {
  await withIsolatedDatabase(() => {
    const userId = Number(userDb.createUser('carol', 'hash').id);
    const endpoint = 'https://push.example.test/reloaded';
    assert.equal(pushSubscriptionsDb.saveSubscription(userId, endpoint, 'key', 'auth'), true);
    pushSubscriptionsDb.setCategories(userId, endpoint, { finished: false, waiting: true, agentMessage: true, system: true });

    assert.equal(pushSubscriptionsDb.saveSubscription(userId, endpoint, 'key2', 'auth2'), false);
    const [stored] = pushSubscriptionsDb.getSubscriptions(userId);
    assert.equal(stored.keys_p256dh, 'key2');
    assert.equal(stored.categories.finished, false);
  });
});
