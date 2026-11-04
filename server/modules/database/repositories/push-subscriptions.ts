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
  /**
   * Upserts a push subscription endpoint for a user, keeping its categories. A browser that sends
   * its subscription is alive, so a "gone" mark from an earlier failed delivery is cleared.
   */
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
         keys_auth = excluded.keys_auth,
         gone_since = NULL`
    ).run(userId, endpoint, keysP256dh, keysAuth);
  },

  /**
   * Notes that the push service called this subscription gone (404/410) and answers since when
   * (epoch ms): the first such answer in a row, kept until a delivery succeeds again.
   */
  markGone(endpoint: string, now: number): number | null {
    const db = getConnection();
    db.prepare('UPDATE push_subscriptions SET gone_since = COALESCE(gone_since, ?) WHERE endpoint = ?').run(now, endpoint);
    const row = db.prepare('SELECT gone_since FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
      { gone_since: number | null } | undefined;
    return row?.gone_since ?? null;
  },

  /** A delivery to this subscription went through. */
  markDelivered(endpoint: string): void {
    const db = getConnection();
    db.prepare('UPDATE push_subscriptions SET gone_since = NULL WHERE endpoint = ? AND gone_since IS NOT NULL').run(endpoint);
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

