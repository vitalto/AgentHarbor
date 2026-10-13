import os from 'node:os';
import path from 'node:path';

import {
  AGENT_SETTING_RULES,
  getStoredAgentSettings,
  type AgentSettingLimits,
  type AgentSettingName,
  type AgentSettings,
} from '@/modules/tmux/agent-settings.js';

export type AgentConfig = AgentSettings & {
  tmuxSession: string;
  claudeCommand: string;
  /** Extra arguments appended to every Claude launch, already shell-quoted (e.g. `--permission-mode default`). */
  claudeArgs: string;
  claudeHome: string;
  stateDir: string;
  /** Claude is the Windows binary started through WSL interop, so it speaks Windows paths. */
  windowsClaude: boolean;
  /** WSL distro name, needed to express Linux-only paths to a Windows Claude. */
  wslDistro: string | null;
};

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const claudeCommand = env.AH_CLAUDE_CMD?.trim() || 'claude';
  return {
    tmuxSession: env.AH_TMUX_SESSION?.trim() || 'main',
    claudeCommand,
    claudeArgs: env.AH_CLAUDE_ARGS?.trim() ?? '',
    claudeHome: env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
    stateDir: env.AH_STATE_DIR?.trim() || path.join(os.homedir(), '.agentharbor'),
    windowsClaude: /\.exe$/i.test(claudeCommand),
    idleCloseMinutes: readNonNegativeNumber(env.AH_IDLE_CLOSE_MINUTES, 60),
    attachmentRetentionDays: readNonNegativeNumber(env.AH_ATTACHMENT_RETENTION_DAYS, 7),
    backgroundReminderMinutes: readNonNegativeNumber(env.AH_BACKGROUND_REMINDER_MINUTES, 60),
    wslDistro: env.WSL_DISTRO_NAME?.trim() || null,
  };
}

/** Read on every call (it is cheap) so env and home-directory overrides in tests apply; saved settings win over env. */
export function getAgentConfig(): AgentConfig {
  return { ...readAgentConfig(), ...getStoredAgentSettings() };
}

export type AgentSettingsOverview = {
  values: AgentSettings;
  /** What each setting falls back to when the user resets it: the environment's value. */
  defaults: AgentSettings;
  limits: Record<AgentSettingName, AgentSettingLimits>;
};

function pickAgentSettings(config: AgentConfig): AgentSettings {
  return {
    idleCloseMinutes: config.idleCloseMinutes,
    attachmentRetentionDays: config.attachmentRetentionDays,
    backgroundReminderMinutes: config.backgroundReminderMinutes,
  };
}

export function describeAgentSettings(): AgentSettingsOverview {
  const limits = Object.fromEntries(Object.entries(AGENT_SETTING_RULES)
    .map(([name, { minimum, maximum }]) => [name, { minimum, maximum }])) as Record<AgentSettingName, AgentSettingLimits>;
  return { values: pickAgentSettings(getAgentConfig()), defaults: pickAgentSettings(readAgentConfig()), limits };
}
