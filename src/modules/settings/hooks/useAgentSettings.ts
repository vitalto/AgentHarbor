import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type AgentSettingName = 'idleCloseMinutes' | 'attachmentRetentionDays' | 'backgroundReminderMinutes';

/** Mirrors the server's AgentSettingsOverview. */
export type AgentSettingsOverview = {
  values: Record<AgentSettingName, number>;
  defaults: Record<AgentSettingName, number>;
  limits: Record<AgentSettingName, { minimum: number; maximum: number }>;
};

type AgentSettingsResponse = {
  success?: boolean;
  settings?: AgentSettingsOverview;
  error?: { message?: string };
};

async function readOverview(response: Response): Promise<AgentSettingsOverview> {
  const body = (await response.json()) as AgentSettingsResponse;
  if (!response.ok || !body.settings) {
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }
  return body.settings;
}

/** Server-wide agent settings: one value for every device and user, unlike the per-user preferences. */
export function useAgentSettings() {
  const [overview, setOverview] = useState<AgentSettingsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSetting, setSavingSetting] = useState<AgentSettingName | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.settings.agentSettings()
      .then(readOverview)
      .then((loaded) => {
        if (!cancelled) {
          setOverview(loaded);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError((loadError as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** `null` returns the setting to its server default. */
  const saveSetting = useCallback(async (name: AgentSettingName, value: number | null) => {
    setSavingSetting(name);
    setError(null);
    try {
      setOverview(await readOverview(await api.settings.saveAgentSettings({ [name]: value })));
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSavingSetting(null);
    }
  }, []);

  return { overview, error, savingSetting, saveSetting };
}
