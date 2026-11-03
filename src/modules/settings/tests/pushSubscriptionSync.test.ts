import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import {
  syncPushSubscription,
  urlBase64ToUint8Array,
  type PushSubscriptionSyncDependencies,
} from '@/modules/settings/utils/pushSubscriptionSync';

const SERVER_KEY = 'BJZMtroXm8jZ-erverKey_AA';
const OLD_KEY = 'BOldKeyOldKeyOldKey-AAAAAAAA';

function fakeSubscription(endpoint: string, key: string) {
  return {
    endpoint,
    options: { applicationServerKey: urlBase64ToUint8Array(key).buffer, userVisibleOnly: true },
    toJSON: () => ({ endpoint, keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` } }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription & { unsubscribe: ReturnType<typeof vi.fn> };
}

function harness(options: {
  permission?: NotificationPermission;
  existing?: PushSubscription | null;
  wanted?: boolean;
  serverAccepts?: boolean;
}) {
  const fresh = fakeSubscription('https://push.example/fresh', SERVER_KEY);
  const registered: PushSubscriptionJSON[] = [];
  const wantedWrites: boolean[] = [];
  const dependencies: PushSubscriptionSyncDependencies = {
    permission: options.permission ?? 'granted',
    pushManager: {
      getSubscription: vi.fn(async () => options.existing ?? null),
      subscribe: vi.fn(async () => fresh),
    },
    fetchVapidPublicKey: vi.fn(async () => SERVER_KEY),
    registerWithServer: vi.fn(async (subscription: PushSubscriptionJSON) => {
      registered.push(subscription);
      return options.serverAccepts ?? true;
    }),
    wantsPush: () => options.wanted ?? false,
    setWantsPush: (wanted) => wantedWrites.push(wanted),
  };
  return { dependencies, registered, wantedWrites };
}

test('a browser that still has its subscription re-registers it with the server on load, silently', async () => {
  const existing = fakeSubscription('https://push.example/kept', SERVER_KEY);
  const { dependencies, registered, wantedWrites } = harness({ existing });

  assert.equal(await syncPushSubscription(dependencies), 'registered');
  assert.deepEqual(registered.map((subscription) => subscription.endpoint), ['https://push.example/kept']);
  assert.equal(vi.mocked(dependencies.pushManager.subscribe).mock.calls.length, 0, 'no new subscription');
  assert.deepEqual(wantedWrites, [true]);
});

test('a subscription made with another server key is replaced, since the server cannot push to it', async () => {
  const existing = fakeSubscription('https://push.example/old-key', OLD_KEY);
  const { dependencies, registered } = harness({ existing });

  assert.equal(await syncPushSubscription(dependencies), 'resubscribed');
  assert.equal(vi.mocked(existing.unsubscribe).mock.calls.length, 1);
  assert.deepEqual(registered.map((subscription) => subscription.endpoint), ['https://push.example/fresh']);
});

test('a browser that lost its subscription subscribes again while the user wants push there', async () => {
  const { dependencies, registered } = harness({ existing: null, wanted: true });

  assert.equal(await syncPushSubscription(dependencies), 'resubscribed');
  assert.deepEqual(registered.map((subscription) => subscription.endpoint), ['https://push.example/fresh']);
});

test('nothing is subscribed where the user never turned push on or turned it off', async () => {
  const { dependencies, registered } = harness({ existing: null, wanted: false });

  assert.equal(await syncPushSubscription(dependencies), 'skipped');
  assert.equal(vi.mocked(dependencies.fetchVapidPublicKey).mock.calls.length, 0);
  assert.deepEqual(registered, []);
});

test('without granted permission the sync never touches the push manager (it must not prompt)', async () => {
  const { dependencies } = harness({ permission: 'default', wanted: true });

  assert.equal(await syncPushSubscription(dependencies), 'skipped');
  assert.equal(vi.mocked(dependencies.pushManager.getSubscription).mock.calls.length, 0);
});

test('a refused registration is reported and does not mark push as wanted', async () => {
  const existing = fakeSubscription('https://push.example/kept', SERVER_KEY);
  const { dependencies, wantedWrites } = harness({ existing, serverAccepts: false });

  assert.equal(await syncPushSubscription(dependencies), 'failed');
  assert.deepEqual(wantedWrites, []);
});
