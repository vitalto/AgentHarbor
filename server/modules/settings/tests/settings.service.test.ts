import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined, getCategories: () => null, setCategories: () => false },
    getVapidPublicKey: () => null,
    agentSettings: { describe: () => ({}), save: () => undefined },
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push without a push of its own', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => { operations.push(`save:${endpoint}`); },
      remove: () => undefined,
      getCategories: () => null,
      setCategories: () => false,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences']);
});

test('updatePushCategories stores a full category set for the browser and refuses an unknown one', () => {
  const stored: unknown[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: () => undefined,
      remove: () => undefined,
      getCategories: () => null,
      setCategories: (_id, endpoint, categories) => {
        stored.push(categories);
        return endpoint === 'https://push.example.test';
      },
    },
  }));

  const result = service.updatePushCategories(1, {
    endpoint: 'https://push.example.test',
    categories: { finished: false },
  });
  assert.deepEqual(result.categories, { finished: false, waiting: true, agentMessage: true, system: true });
  assert.deepEqual(stored, [result.categories]);
  assert.throws(() => service.updatePushCategories(1, { endpoint: 'https://other.example.test', categories: {} }), /not found/);
  assert.throws(() => service.getPushCategories(1, 'https://other.example.test'), /not found/);
});

test('updateAgentSettings saves the update and answers with the settings as they are now', () => {
  let saved: unknown = null;
  let current = { idleCloseMinutes: 60 };
  const service = createSettingsService(dependencies({
    agentSettings: {
      describe: () => current,
      save: (input) => {
        saved = input;
        current = { idleCloseMinutes: 15 };
      },
    },
  }));

  assert.deepEqual(service.updateAgentSettings({ idleCloseMinutes: 15 }), {
    success: true,
    settings: { idleCloseMinutes: 15 },
  });
  assert.deepEqual(saved, { idleCloseMinutes: 15 });
});

test('turning push off in one browser leaves Web Push on for the other browsers', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: () => undefined,
      remove: (endpoint) => { operations.push(`remove:${endpoint}`); },
      getCategories: () => null,
      setCategories: () => false,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: true } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
    },
  }));

  service.unsubscribeFromPush(1, 'https://push.example.test/laptop');
  assert.deepEqual(operations, ['remove:https://push.example.test/laptop']);
});

test('saving the other notification options never switches Web Push off', () => {
  const saved: unknown[] = [];
  const service = createSettingsService(dependencies({
    notifications: {
      getPreferences: () => ({ channels: { webPush: true, sound: true } }),
      updatePreferences: (_id, preferences) => { saved.push(preferences); return preferences; },
    },
  }));

  service.updateNotificationPreferences(1, { channels: { webPush: false, sound: false } });
  assert.deepEqual(saved, [{ channels: { webPush: true, sound: false } }]);
});
