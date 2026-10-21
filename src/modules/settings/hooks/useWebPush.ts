import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { NotificationCategories } from '@/shared/types';

type WebPushState = {
  permission: NotificationPermission | 'unsupported';
  /** Opened over plain http on a non-localhost address: Chrome hides service workers and push there. */
  insecureContext: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  /** This browser's categories, or null until they are loaded (or when not subscribed). */
  categories: NotificationCategories | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  setCategory: (category: keyof NotificationCategories, enabled: boolean) => Promise<void>;
};

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function loadCategories(endpoint: string): Promise<NotificationCategories | null> {
  const response = await api.settings.push.categories(endpoint);
  if (!response.ok) {
    return null;
  }
  const { categories } = await response.json();
  return categories ?? null;
}

export function useWebPush(): WebPushState {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (
      typeof window === 'undefined'
      || !('Notification' in window)
      || !('serviceWorker' in navigator)
    ) {
      return 'unsupported';
    }
    return Notification.permission;
  });
  const insecureContext = typeof window !== 'undefined' && !window.isSecureContext;
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [categories, setCategories] = useState<NotificationCategories | null>(null);

  // Check existing subscription on mount
  useEffect(() => {
    if (permission === 'unsupported') return;

    currentSubscription().then(async (sub) => {
      setIsSubscribed(sub !== null);
      setCategories(sub ? await loadCategories(sub.endpoint) : null);
    }).catch(() => {
      // SW not ready yet
    });
  }, [permission]);

  const subscribe = useCallback(async () => {
    if (permission === 'unsupported') return;
    setIsLoading(true);

    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return;

      const keyRes = await api.settings.push.vapidPublicKey();
      const { publicKey } = await keyRes.json();

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const subJson = subscription.toJSON();
      await api.settings.push.subscribe({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      });

      setIsSubscribed(true);
      setCategories(await loadCategories(subscription.endpoint));
    } catch (err) {
      console.error('Push subscribe failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [permission]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await api.settings.push.unsubscribe(endpoint);
      }
      setIsSubscribed(false);
      setCategories(null);
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setCategory = useCallback(async (category: keyof NotificationCategories, enabled: boolean) => {
    if (!categories) return;
    const previous = categories;
    const next = { ...categories, [category]: enabled };
    setCategories(next);
    try {
      const subscription = await currentSubscription();
      const response = subscription ? await api.settings.push.saveCategories(subscription.endpoint, next) : null;
      if (!response?.ok) {
        setCategories(previous);
      }
    } catch (err) {
      console.error('Saving notification categories failed:', err);
      setCategories(previous);
    }
  }, [categories]);

  return { permission, insecureContext, isSubscribed, isLoading, categories, subscribe, unsubscribe, setCategory };
}
