import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useAgentSettings, type AgentSettingName, type AgentSettingsOverview } from '@/modules/settings/hooks/useAgentSettings';
import { useShutdownWhenIdle, type ShutdownWhenIdleState, type WatchedAgent } from '@/modules/settings/hooks/useShutdownWhenIdle';
import { Button, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';

type NumberSettingRowProps = {
  name: AgentSettingName;
  overview: AgentSettingsOverview;
  isSaving: boolean;
  onSave: (name: AgentSettingName, value: number | null) => void;
};

function NumberSettingRow({ name, overview, isSaving, onSave }: NumberSettingRowProps) {
  const { t } = useTranslation('settings');
  const savedValue = overview.values[name];
  const defaultValue = overview.defaults[name];
  const { minimum, maximum } = overview.limits[name];
  const [draft, setDraft] = useState(String(savedValue));

  const parsedDraft = Number(draft);
  const isDraftValid = draft.trim() !== '' && Number.isInteger(parsedDraft) && parsedDraft >= minimum && parsedDraft <= maximum;

  const commitDraft = () => {
    if (!isDraftValid) {
      setDraft(String(savedValue));
      return;
    }
    if (parsedDraft !== savedValue) {
      onSave(name, parsedDraft);
    }
  };

  return (
    <SettingsRow
      label={t(`runtime.settings.${name}.label`)}
      description={t(`runtime.settings.${name}.description`, { defaultValue, minimum, maximum })}
    >
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={minimum}
            max={maximum}
            step={1}
            value={draft}
            disabled={isSaving}
            aria-label={t(`runtime.settings.${name}.label`)}
            aria-invalid={!isDraftValid}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
            className={cn('w-24 text-right', !isDraftValid && 'border-destructive')}
          />
          <span className="w-10 text-sm text-muted-foreground">{t(`runtime.settings.${name}.unit`)}</span>
        </div>
        {savedValue !== defaultValue && (
          <button
            type="button"
            disabled={isSaving}
            onClick={() => onSave(name, null)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t('runtime.resetToDefault', { value: defaultValue })}
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

function describeAgent(agent: WatchedAgent): string {
  if (agent.title) {
    return agent.title;
  }
  const folder = agent.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return folder || agent.providerSessionId.slice(0, 8);
}

function ShutdownStatus({ state, onCancel, isUpdating }: {
  state: ShutdownWhenIdleState;
  onCancel: () => void;
  isUpdating: boolean;
}) {
  const { t } = useTranslation('settings');

  if (state.shutdownAt !== null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <p className="text-sm font-medium text-orange-700 dark:text-orange-300">
          {t('runtime.power.shuttingDown', { time: new Date(state.shutdownAt).toLocaleTimeString() })}
        </p>
        <Button variant="destructive" size="sm" disabled={isUpdating} onClick={onCancel}>
          {t('runtime.power.cancelShutdown')}
        </Button>
      </div>
    );
  }

  if (!state.armed) {
    return state.lastError ? (
      <p className="px-4 py-3 text-sm text-destructive">{t('runtime.power.failed', { error: state.lastError })}</p>
    ) : null;
  }

  if (state.checkedAt === null) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">{t('runtime.power.checking')}</p>;
  }

  if (state.unfinishedAgents.length === 0) {
    // Measured on the server's clock, which may differ from this device's.
    const quietRemainingMs = Math.max(0, (state.idleSince ?? state.checkedAt) + state.quietPeriodMs - state.checkedAt);
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {t('runtime.power.allFinished', { seconds: Math.ceil(quietRemainingMs / 1000) })}
      </p>
    );
  }

  return (
    <div className="space-y-2 px-4 py-3">
      <p className="text-sm text-muted-foreground">
        {t('runtime.power.waitingFor', { count: state.unfinishedAgents.length })}
      </p>
      <ul className="space-y-1">
        {state.unfinishedAgents.map((agent) => (
          <li key={agent.providerSessionId} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-foreground">{describeAgent(agent)}</span>
            <span className="flex-shrink-0 text-muted-foreground">{t(`runtime.power.work.${agent.work}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Rendered by AgentCategoryContentSection for the "runtime" category: server-wide agent lifecycle settings. */
export default function RuntimeContent() {
  const { t } = useTranslation('settings');
  const { overview, error: settingsError, savingSetting, saveSetting } = useAgentSettings();
  const { state: shutdownState, requestError, isUpdating, setArmed, cancelShutdown } = useShutdownWhenIdle();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('runtime.windows.title')} description={t('runtime.windows.description')}>
        {overview ? (
          <SettingsCard divided>
            {(['idleCloseMinutes', 'attachmentRetentionDays'] as const).map((name) => (
              <NumberSettingRow
                // A saved value remounts the row, so its draft starts from what the server now holds.
                key={`${name}:${overview.values[name]}`}
                name={name}
                overview={overview}
                isSaving={savingSetting === name}
                onSave={(settingName, value) => void saveSetting(settingName, value)}
              />
            ))}
          </SettingsCard>
        ) : (
          !settingsError && <p className="text-sm text-muted-foreground">{t('runtime.loading')}</p>
        )}
        {settingsError && <p className="text-sm text-destructive">{settingsError}</p>}
      </SettingsSection>

      <SettingsSection title={t('runtime.power.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('runtime.power.label')}
            description={shutdownState
              ? t('runtime.power.description', {
                minutes: Math.round(shutdownState.quietPeriodMs / 60_000),
                seconds: shutdownState.shutdownDelaySeconds,
              })
              : undefined}
          >
            <SettingsToggle
              checked={shutdownState?.armed ?? false}
              disabled={!shutdownState || isUpdating}
              onChange={(armed) => void setArmed(armed)}
              ariaLabel={t('runtime.power.label')}
            />
          </SettingsRow>
          {shutdownState && (
            <ShutdownStatus state={shutdownState} onCancel={() => void cancelShutdown()} isUpdating={isUpdating} />
          )}
        </SettingsCard>
        {requestError && <p className="text-sm text-destructive">{requestError}</p>}
      </SettingsSection>
    </div>
  );
}
