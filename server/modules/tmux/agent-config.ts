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
  /** Idle Claude windows close after this many minutes without activity; 0 keeps them open. */
  idleCloseMinutes: number;
  /** WSL distro name, needed to express Linux-only paths to a Windows Claude. */
  wslDistro: string | null;
};

function readMinutes(value: string | undefined, fallback: number): number {
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
    idleCloseMinutes: readMinutes(env.AH_IDLE_CLOSE_MINUTES, 60),
    wslDistro: env.WSL_DISTRO_NAME?.trim() || null,
  };
}

/** Read on every call (it is cheap) so env and home-directory overrides in tests apply. */
export function getAgentConfig(): AgentConfig {
  return readAgentConfig();
}
