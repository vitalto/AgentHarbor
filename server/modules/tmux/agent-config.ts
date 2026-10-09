import os from 'node:os';
import path from 'node:path';

export type AgentConfig = {
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

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const claudeCommand = env.AH_CLAUDE_CMD?.trim() || 'claude';
  return {
    tmuxSession: env.AH_TMUX_SESSION?.trim() || 'main',
    claudeCommand,
    claudeArgs: env.AH_CLAUDE_ARGS?.trim() ?? '',
    claudeHome: env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
    stateDir: env.AH_STATE_DIR?.trim() || path.join(os.homedir(), '.agentharbor'),
    windowsClaude: /\.exe$/i.test(claudeCommand),
    wslDistro: env.WSL_DISTRO_NAME?.trim() || null,
  };
}

let cachedConfig: AgentConfig | null = null;

export function getAgentConfig(): AgentConfig {
  cachedConfig ??= readAgentConfig();
  return cachedConfig;
}

/** Tests swap the process-wide config; passing null restores env-derived defaults. */
export function setAgentConfigForTests(config: AgentConfig | null): void {
  cachedConfig = config;
}
