import { useEffect } from 'react';

import { api } from '@/shared/api';
import { isPushWanted, rememberPushWanted, syncPushSubscription } from '@/modules/settings/utils/pushSubscriptionSync';

/** A page whose service worker never activates (no push support there) must not wait forever. */
const SERVICE_WORKER_READY_TIMEOUT_MS = 15_000;

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

async function runPushSubscriptionSync(): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !window.isSecureContext) {
    return;
  }
  const registration = await readyRegistration();
  if (!registration?.pushManager) {
    return;
  }
  await syncPushSubscription({
    permission: Notification.permission,
    pushManager: registration.pushManager,
    fetchVapidPublicKey: async () => {
      const response = await api.settings.push.vapidPublicKey();
      return response.ok ? ((await response.json()) as { publicKey?: string | null }).publicKey ?? null : null;
    },
    registerWithServer: async (subscription) => {
      const response = await api.settings.push.subscribe({ endpoint: subscription.endpoint, keys: subscription.keys });
      return response.ok;
    },
    wantsPush: isPushWanted,
    setWantsPush: rememberPushWanted,
  });
}

/**
 * Used by App inside the auth gate: on every page load (and when the service worker reports that
 * the browser replaced its subscription) this browser's push subscription is re-registered with
 * the server, so a subscription the server dropped or the browser rotated starts receiving again.
 */
export function PushSubscriptionSync(): null {
  useEffect(() => {
    void runPushSubscriptionSync();
    if (!('serviceWorker' in navigator)) {
      return undefined;
    }
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'push:subscription-changed') {
        void runPushSubscriptionSync();
      }
    };
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onWorkerMessage);
  }, []);
  return null;
}
