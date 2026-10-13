import { appConfigDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** Agent behaviour the user changes in Settings; the environment only supplies the defaults. */
export type AgentSettings = {
  /** Idle Claude windows close after this many minutes without activity; 0 keeps them open. */
  idleCloseMinutes: number;
  /** Copies of pasted files made for a Windows Claude are deleted after this many days. */
  attachmentRetentionDays: number;
};

export type AgentSettingName = keyof AgentSettings;

export type AgentSettingLimits = { minimum: number; maximum: number };

type AgentSettingRule = AgentSettingLimits & { storageKey: string };

export const AGENT_SETTING_RULES: Record<AgentSettingName, AgentSettingRule> = {
  idleCloseMinutes: { storageKey: 'agent_settings.idle_close_minutes', minimum: 0, maximum: 7 * 24 * 60 },
  attachmentRetentionDays: { storageKey: 'agent_settings.attachment_retention_days', minimum: 1, maximum: 365 },
};

const AGENT_SETTING_NAMES = Object.keys(AGENT_SETTING_RULES) as AgentSettingName[];

const isAgentSettingName = (name: string): name is AgentSettingName => Object.hasOwn(AGENT_SETTING_RULES, name);

function isAllowedValue(name: AgentSettingName, value: unknown): value is number {
  const { minimum, maximum } = AGENT_SETTING_RULES[name];
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

// Kept in memory because getAgentConfig() runs on every tmux call; this process is the only writer.
let storedSettings: Partial<AgentSettings> = {};

/** Reads the saved values once the database is open; until then only the environment defaults apply. */
export function loadStoredAgentSettings(): void {
  const loaded: Partial<AgentSettings> = {};
  for (const name of AGENT_SETTING_NAMES) {
    const raw = appConfigDb.get(AGENT_SETTING_RULES[name].storageKey);
    const value = raw === null ? Number.NaN : Number(raw);
    if (isAllowedValue(name, value)) {
      loaded[name] = value;
    }
  }
  storedSettings = loaded;
}

export function getStoredAgentSettings(): Partial<AgentSettings> {
  return storedSettings;
}

/**
 * Applies a partial update: a number saves that setting, `null` returns it to
 * its environment default. The whole update is validated before anything is written.
 */
export function saveAgentSettings(input: unknown): Partial<AgentSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Settings must be an object.', { code: 'INVALID_AGENT_SETTINGS', statusCode: 400 });
  }
  const updates: Array<[AgentSettingName, number | null]> = [];
  for (const [name, value] of Object.entries(input)) {
    if (!isAgentSettingName(name)) {
      throw new AppError(`Unknown setting "${name}".`, { code: 'INVALID_AGENT_SETTINGS', statusCode: 400 });
    }
    if (value !== null && !isAllowedValue(name, value)) {
      const { minimum, maximum } = AGENT_SETTING_RULES[name];
      throw new AppError(`${name} must be a whole number from ${minimum} to ${maximum}.`, {
        code: 'INVALID_AGENT_SETTINGS',
        statusCode: 400,
      });
    }
    updates.push([name, value]);
  }

  const nextSettings = { ...storedSettings };
  for (const [name, value] of updates) {
    const { storageKey } = AGENT_SETTING_RULES[name];
    if (value === null) {
      appConfigDb.remove(storageKey);
      delete nextSettings[name];
    } else {
      appConfigDb.set(storageKey, String(value));
      nextSettings[name] = value;
    }
  }
  storedSettings = nextSettings;
  return storedSettings;
}
