/**
 * Push subscriptions repository.
 *
 * Persists browser push subscription endpoints and keys per user.
 */

import { getConnection } from '@/modules/database/connection.js';
import {
  normalizeNotificationCategories,
  type NotificationCategories,
} from '@/shared/notification-categories.js';

type PushSubscriptionLookupRow = {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  categories: NotificationCategories;
};

type PushSubscriptionRow = Omit<PushSubscriptionLookupRow, 'categories'> & { categories_json: string | null };

const withCategories = ({ categories_json, ...row }: PushSubscriptionRow): PushSubscriptionLookupRow => ({
  ...row,
  categories: normalizeNotificationCategories(categories_json),
});

export const pushSubscriptionsDb = {
  /** Upserts a push subscription endpoint for a user. */
  createPushSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string
  ): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         keys_p256dh = excluded.keys_p256dh,
         keys_auth = excluded.keys_auth`
    ).run(userId, endpoint, keysP256dh, keysAuth);
  },

  /** Returns all subscriptions for a user. */
  getPushSubscriptions(userId: number): PushSubscriptionLookupRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        'SELECT endpoint, keys_p256dh, keys_auth, categories_json FROM push_subscriptions WHERE user_id = ?'
      )
      .all(userId) as PushSubscriptionRow[];
    return rows.map(withCategories);
  },

  /** Users with at least one subscribed browser: whom agent activity is reported to. */
  getSubscribedUserIds(): number[] {
    const db = getConnection();
    const rows = db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all() as { user_id: number }[];
    return rows.map((row) => row.user_id);
  },

  /** The categories one browser receives, or null when that browser is not subscribed for the user. */
  getCategories(userId: number, endpoint: string): NotificationCategories | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT categories_json FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .get(userId, endpoint) as { categories_json: string | null } | undefined;
    return row ? normalizeNotificationCategories(row.categories_json) : null;
  },

  /** Stores one browser's categories; false when that browser is not subscribed for the user. */
  setCategories(userId: number, endpoint: string, categories: NotificationCategories): boolean {
    const db = getConnection();
    const result = db
      .prepare('UPDATE push_subscriptions SET categories_json = ? WHERE user_id = ? AND endpoint = ?')
      .run(JSON.stringify(categories), userId, endpoint);
    return result.changes > 0;
  },

  /** Deletes one subscription by endpoint. */
  deletePushSubscription(endpoint: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },

  /** Deletes all subscriptions for a user. */
  deletePushSubscriptionsForUser(userId: number): void {
    const db = getConnection();
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  },

  // Legacy aliases used by existing services/routes
  saveSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string
  ): void {
    pushSubscriptionsDb.createPushSubscription(
      userId,
      endpoint,
      keysP256dh,
      keysAuth
    );
  },
  getSubscriptions(userId: number): PushSubscriptionLookupRow[] {
    return pushSubscriptionsDb.getPushSubscriptions(userId);
  },
  removeSubscription(endpoint: string): void {
    pushSubscriptionsDb.deletePushSubscription(endpoint);
  },
  removeAllForUser(userId: number): void {
    pushSubscriptionsDb.deletePushSubscriptionsForUser(userId);
  },
};

