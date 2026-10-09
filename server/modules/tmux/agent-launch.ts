import fs from 'node:fs';
import path from 'node:path';

import type { AgentConfig } from '@/modules/tmux/agent-config.js';
import { toClaudePath } from '@/modules/tmux/path-translation.js';

/**
 * Written by the SessionStart hook: `<n>-<pid>.json` where n is the tmux pane
 * number and pid the pane's process. The pid keeps a file from a previous tmux
 * server from being attributed to a new pane that reused the same number.
 */
export const PANES_DIRECTORY = 'panes';

const HOOK_COMMAND =
  'if [ -n "$AH_PANE" ]; then mkdir -p "$AH_STATE_DIR/panes" && cat > "$AH_STATE_DIR/panes/$AH_PANE.json"; else cat > /dev/null; fi';

export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hookSettingsPath(config: AgentConfig): string {
  return path.join(config.stateDir, 'hook-settings.json');
}

/** Returns the settings path as Claude must see it on its command line. */
export function writeHookSettings(config: AgentConfig): string {
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
    },
  };
  fs.mkdirSync(path.join(config.stateDir, PANES_DIRECTORY), { recursive: true });
  fs.writeFileSync(hookSettingsPath(config), `${JSON.stringify(settings, null, 2)}\n`);
  return toClaudePath(hookSettingsPath(config), config);
}

export type AgentLaunch = { command: string; env: Record<string, string> };

export function buildAgentLaunch(
  config: AgentConfig,
  input: { resumeSessionId?: string; newSessionId?: string },
): AgentLaunch {
  const sessionArgs = input.resumeSessionId
    ? ` --resume ${quoteForShell(input.resumeSessionId)}`
    : input.newSessionId
      ? ` --session-id ${quoteForShell(input.newSessionId)}`
      : '';
  const settingsArg = ` --settings ${quoteForShell(toClaudePath(hookSettingsPath(config), config))}`;

  // `exec` makes Claude the pane process, so `$$` here equals tmux's #{pane_pid}.
  const extraArgs = config.claudeArgs ? ` ${config.claudeArgs}` : '';
  const command = `export AH_PANE="\${TMUX_PANE#%}-$$"; exec ${quoteForShell(config.claudeCommand)}${settingsArg}${extraArgs}${sessionArgs}`;

  const env: Record<string, string> = { AH_STATE_DIR: config.stateDir };
  if (config.windowsClaude) {
    // WSL interop only forwards variables listed here; /p converts the path to Windows form.
    env.WSLENV = 'AH_PANE:AH_STATE_DIR/p';
  }
  return { command, env };
}
