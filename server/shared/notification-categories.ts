/**
 * What a device can be notified about. Each push subscription (one per browser)
 * keeps its own set, so a phone can take everything while a desktop takes only
 * questions.
 */
export const NOTIFICATION_CATEGORIES = ['finished', 'waiting', 'agentMessage', 'system'] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationCategories = Record<NotificationCategory, boolean>;

/** Missing or unreadable entries count as on: a new category reaches existing devices until they turn it off. */
export function normalizeNotificationCategories(value: unknown): NotificationCategories {
  let source: unknown = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      source = null;
    }
  }
  const record = source && typeof source === 'object' ? source as Record<string, unknown> : {};
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, record[category] !== false]),
  ) as NotificationCategories;
}

const CATEGORY_BY_EVENT_KIND: Record<string, NotificationCategory> = {
  stop: 'finished',
  error: 'finished',
  action_required: 'waiting',
  agent_message: 'agentMessage',
};

export function categoryOfEventKind(kind: string | undefined): NotificationCategory {
  return (kind && CATEGORY_BY_EVENT_KIND[kind]) || 'system';
}
