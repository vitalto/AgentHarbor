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
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
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

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
      getCategories: () => null,
      setCategories: () => false,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
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
