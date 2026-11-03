/** Set on this browser when the user turns push on, cleared when they turn it off. */
const PUSH_WANTED_STORAGE_KEY = 'agentharbor.webPush.wanted';

/** What the page can do with this browser's push subscription; injectable so the decisions are testable. */
export type PushSubscriptionSyncDependencies = {
  permission: NotificationPermission | 'unsupported';
  pushManager: Pick<PushManager, 'getSubscription' | 'subscribe'>;
  fetchVapidPublicKey: () => Promise<string | null>;
  /** Stores the subscription on the server; resolves false when the server refused it. */
  registerWithServer: (subscription: PushSubscriptionJSON) => Promise<boolean>;
  wantsPush: () => boolean;
  setWantsPush: (wanted: boolean) => void;
};

export type PushSubscriptionSyncResult = 'registered' | 'resubscribed' | 'skipped' | 'failed';

/** Used by useWebPush to subscribe with the server's key. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function sameKey(subscriptionKey: ArrayBuffer | null | undefined, serverKey: Uint8Array): boolean {
  if (!subscriptionKey) {
    // Browsers that do not expose the key: trust the subscription rather than replace it on every load.
    return true;
  }
  const bytes = new Uint8Array(subscriptionKey);
  return bytes.length === serverKey.length && bytes.every((byte, index) => byte === serverKey[index]);
}

/** Used by useWebPush when the user turns push on or off in Settings. */
export function rememberPushWanted(wanted: boolean): void {
  try {
    if (wanted) {
      localStorage.setItem(PUSH_WANTED_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(PUSH_WANTED_STORAGE_KEY);
    }
  } catch {
    // Storage blocked: the browser's own subscription still drives the sync.
  }
}

/** Used by the default sync dependencies to read the flag rememberPushWanted writes. */
export function isPushWanted(): boolean {
  try {
    return localStorage.getItem(PUSH_WANTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Used by the settings module's PushSubscriptionSync on every page load. The server can lose a
 * browser (it drops one the push service calls gone) and a browser can lose or rotate its
 * subscription on its own; until now only a click on "Enable" told the server again, so pushes
 * stopped silently. This re-sends the browser's subscription, replaces one made with an old key,
 * and re-subscribes a browser that lost its subscription while the user still wants push here.
 * Never asks for permission: it runs only where permission is already granted.
 */
export async function syncPushSubscription(dependencies: PushSubscriptionSyncDependencies): Promise<PushSubscriptionSyncResult> {
  if (dependencies.permission !== 'granted') {
    return 'skipped';
  }
  try {
    const existing = await dependencies.pushManager.getSubscription();
    if (!existing && !dependencies.wantsPush()) {
      return 'skipped';
    }
    const publicKey = await dependencies.fetchVapidPublicKey();
    if (!publicKey) {
      return 'failed';
    }
    const serverKey = urlBase64ToUint8Array(publicKey);
    if (existing && sameKey(existing.options?.applicationServerKey, serverKey)) {
      const registered = await dependencies.registerWithServer(existing.toJSON());
      if (registered) {
        dependencies.setWantsPush(true);
      }
      return registered ? 'registered' : 'failed';
    }
    if (existing) {
      await existing.unsubscribe();
    }
    const fresh = await dependencies.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey.buffer as ArrayBuffer,
    });
    const registered = await dependencies.registerWithServer(fresh.toJSON());
    if (registered) {
      dependencies.setWantsPush(true);
    }
    return registered ? 'resubscribed' : 'failed';
  } catch (error) {
    console.warn('Push subscription sync failed:', error);
    return 'failed';
  }
}
