import { Bell, BellOff, BellRing, Loader2, Play, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { playChatCompletionSound } from '@/shared/utils';
import type { NotificationCategories, NotificationPreferencesState } from '@/shared/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  pushInsecureContext: boolean;
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  pushCategories: NotificationCategories | null;
  onEnablePush: () => void;
  onDisablePush: () => void;
  onPushCategoryChange: (category: keyof NotificationCategories, enabled: boolean) => void;
};

const PUSH_CATEGORIES: Array<keyof NotificationCategories> = ['finished', 'waiting', 'agentMessage', 'system'];
const INSECURE_ORIGIN_FLAG = 'chrome://flags/#unsafely-treat-insecure-origin-as-secure';

/** Rendered by Settings for the "notifications" tab, covering notification channels and events. */
export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  pushInsecureContext,
  isPushSubscribed,
  isPushLoading,
  pushCategories,
  onEnablePush,
  onDisablePush,
  onPushCategoryChange,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-foreground">{t('notifications.webPush.title')}</h4>
        {pushInsecureContext ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{t('notifications.webPush.insecure.reason')}</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                {t('notifications.webPush.insecure.openFlag')}{' '}
                <code className="select-all break-all rounded bg-muted px-1 text-foreground">{INSECURE_ORIGIN_FLAG}</code>
              </li>
              <li>
                {t('notifications.webPush.insecure.addOrigin')}{' '}
                <code className="select-all break-all rounded bg-muted px-1 text-foreground">{window.location.origin}</code>
              </li>
              <li>{t('notifications.webPush.insecure.relaunch')}</li>
            </ol>
            <p>{t('notifications.webPush.insecure.localhost')}</p>
          </div>
        ) : !pushSupported ? (
          <p className="text-sm text-muted-foreground">{t('notifications.webPush.unsupported')}</p>
        ) : pushDenied ? (
          <p className="text-sm text-muted-foreground">{t('notifications.webPush.denied')}</p>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isPushLoading}
              onClick={() => {
                if (isPushSubscribed) {
                  onDisablePush();
                } else {
                  onEnablePush();
                }
              }}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isPushSubscribed
                  ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                  : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
              }`}
            >
              {isPushLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isPushSubscribed ? (
                <BellOff className="h-4 w-4" />
              ) : (
                <BellRing className="h-4 w-4" />
              )}
              {isPushLoading
                ? t('notifications.webPush.loading')
                : isPushSubscribed
                  ? t('notifications.webPush.disable')
                  : t('notifications.webPush.enable')}
            </button>
            {isPushSubscribed && (
              <span className="text-sm text-green-600 dark:text-green-400">
                {t('notifications.webPush.enabled')}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-blue-600" />
              <h4 className="font-medium text-foreground">
                {t('notifications.sound.title', { defaultValue: 'Sound' })}
              </h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('notifications.sound.description', {
                defaultValue: 'Play a short tone when a chat run finishes.',
              })}
            </p>
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.channels.sound}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  channels: {
                    ...notificationPreferences.channels,
                    sound: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.sound.enabled', { defaultValue: 'Enabled' })}
          </label>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void playChatCompletionSound({ force: true });
          }}
        >
          <Play className="h-4 w-4" />
          {t('notifications.sound.test', { defaultValue: 'Test sound' })}
        </Button>
      </div>

      {isPushSubscribed && pushCategories && (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <h4 className="font-medium text-foreground">{t('notifications.categories.title')}</h4>
            <p className="text-sm text-muted-foreground">{t('notifications.categories.description')}</p>
          </div>
          <div className="space-y-3">
            {PUSH_CATEGORIES.map((category) => (
              <label key={category} className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={pushCategories[category]}
                  onChange={(event) => onPushCategoryChange(category, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  {t(`notifications.categories.${category}.label`)}
                  <span className="block text-xs text-muted-foreground">
                    {t(`notifications.categories.${category}.description`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
