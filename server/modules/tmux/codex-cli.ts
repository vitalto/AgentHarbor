import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';
import { getCodexHome } from '@/shared/utils.js';

/** Keeps the Codex catalog, authentication, session index and live terminal on the same CLI profile. */
export function getCodexCliConfig() {
  const executable = process.env.AH_CODEX_CMD?.trim() || 'codex';
  const home = getCodexHome();
  const windowsInterop = process.platform === 'linux' && /\.exe$/i.test(executable);
  const env = { ...process.env };
  if (env.AH_CODEX_HOME) env.CODEX_HOME = home;
  if (windowsInterop) {
    const forwarded = (env.WSLENV ?? '').split(':').filter((entry) => entry && !/^(CODEX_HOME|TERM)(\/|$)/.test(entry));
    env.WSLENV = [...forwarded, ...(env.CODEX_HOME ? ['CODEX_HOME/p'] : []), 'TERM'].join(':');
  }

  return { executable, home, env, pathConfig: { ...getAgentConfig(), windowsClaude: windowsInterop } };
}

/** Used by the Codex TUI input driver for message text and attachment paths. */
export async function pasteCodexText(paneId: string, text: string, windowsInterop = getCodexCliConfig().pathConfig.windowsClaude) {
  // ConPTY's keyboard translation can lose even ASCII punctuation such as ">".
  // Pair each press with a release so Codex receives consecutive identical letters.
  // Leave line breaks and supplementary characters to the normal tmux paste path.
  const input = windowsInterop
    ? text.replace(/[\u0020-\u007e\u0080-\uffff]/gu, (character) => {
      const code = character.charCodeAt(0);
      return `\x1b[0;0;${code};1;0;1_\x1b[0;0;${code};0;0;1_`;
    })
    : text;
  await tmuxService.pasteText(paneId, input);
}
