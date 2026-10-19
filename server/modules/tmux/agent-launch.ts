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

const ELEVATION_HINT =
  'UAC prompts cannot be answered here: the user is remote and nobody can click a prompt on this PC. '
  + 'Run the part that needs admin rights with  elevate "<PowerShell command>"  (Git Bash) or  elevate.ps1 -Command "<PowerShell command>"  (PowerShell). '
  + 'It waits until the user approves that exact command in AgentHarbor, runs it elevated in the current directory and prints its output and exit code '
  + '(126 = denied: do not retry, ask the user; 124 = nobody approved within 5 minutes). '
  + 'Approval can take up to 5 minutes: give the call a 600000 ms timeout or run it in the background. '
  + 'A script that elevates itself must be run through elevate without its own RunAs step.';

/**
 * Blocks the ways agents usually trigger UAC (Start-Process -Verb RunAs, runas /user, Windows
 * sudo) and points them to `elevate` (an optional external Windows broker). Only once the elevation
 * broker is installed (it starts on demand), so without it everything behaves as before. The `case` filter spawns nothing
 * for ordinary commands, since this runs before every shell call.
 */
const ELEVATION_HOOK_COMMAND = String.raw`input=$(cat)
case "$input" in *[Rr][Uu][Nn][Aa][Ss]*|*[Ss][Uu][Dd][Oo]*) ;; *) exit 0 ;; esac
[ -f "${'$'}{PROGRAMDATA:-C:/ProgramData}/ElevationBroker/broker.ps1" ] || exit 0
command=$(printf '%s' "$input" | sed -n 's/.*"command":"\(\([^"\\]\|\\.\)*\)".*/\1/p')
if printf '%s' "$command" | grep -qiE -- '-verb[^a-z]{1,6}runas|(^|[^a-z0-9_-])runas(\.exe)?[[:space:]]+/' \
  || { printf '%s' "$command" | grep -qiE -- '(^|[^a-z0-9_.-])sudo(\.exe)?[[:space:]]' && ! printf '%s' "$command" | grep -qiE -- 'wsl|ssh'; }; then
  echo ${quoteForShell(ELEVATION_HINT)} >&2
  exit 2
fi`;

export function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hookSettingsPath(config: AgentConfig): string {
  return path.join(config.stateDir, 'hook-settings.json');
}

/** Returns the settings path as Claude must see it on its command line. */
export function writeHookSettings(config: AgentConfig): string {
  const settings = {
    // Agent view (← in the TUI, /background) parks the conversation in Claude's daemon under a NEW
    // session id: the window turns into a mere viewer, the conversation runs outside tmux, its
    // in-flight background commands end with exit code -1, and the daemon's spare process inherits
    // AH_PANE and overwrites this window's registration. The app is already the agent view here.
    disableAgentView: true,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: ELEVATION_HOOK_COMMAND }] }],
    },
  };
  fs.mkdirSync(path.join(config.stateDir, PANES_DIRECTORY), { recursive: true });
  fs.writeFileSync(hookSettingsPath(config), `${JSON.stringify(settings, null, 2)}\n`);
  return toClaudePath(hookSettingsPath(config), config);
}

export type AgentLaunch = { command: string; env: Record<string, string> };

export function buildAgentLaunch(
  config: AgentConfig,
  input: { resumeSessionId?: string; newSessionId?: string; selectionArgs?: string[] },
): AgentLaunch {
  const selectionArgs = (input.selectionArgs ?? []).map((arg) => ` ${quoteForShell(arg)}`).join('');
  const sessionArgs = input.resumeSessionId
    ? ` --resume ${quoteForShell(input.resumeSessionId)}`
    : input.newSessionId
      ? ` --session-id ${quoteForShell(input.newSessionId)}`
      : '';
  const settingsArg = ` --settings ${quoteForShell(toClaudePath(hookSettingsPath(config), config))}`;

  // `exec` makes Claude the pane process, so `$$` here equals tmux's #{pane_pid}.
  const extraArgs = config.claudeArgs ? ` ${config.claudeArgs}` : '';
  const command = `export AH_PANE="\${TMUX_PANE#%}-$$"; exec ${quoteForShell(config.claudeCommand)}${settingsArg}${extraArgs}${selectionArgs}${sessionArgs}`;

  const env: Record<string, string> = { AH_STATE_DIR: config.stateDir };
  if (config.windowsClaude) {
    // WSL interop only forwards variables listed here; /p converts the path to Windows form.
    env.WSLENV = 'AH_PANE:AH_STATE_DIR/p';
  }
  return { command, env };
}
