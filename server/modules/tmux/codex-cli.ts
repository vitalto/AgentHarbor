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

function windowsKey(virtualKey: number, scan: number, unicode: number, modifiers = 0): string {
  const fields = `${virtualKey};${scan};${unicode}`;
  return `\x1b[${fields};1;${modifiers};1_\x1b[${fields};0;${modifiers};1_`;
}

const endKey = windowsKey(35, 79, 0, 256);
const newline = windowsKey(13, 28, 13, 16);
// VK_TAB queues a message. With the high byte set, the Win32 character
// lookup still maps the low byte to HT and Crossterm delivers literal text.
const literalTab = windowsKey(0x100 | 9, 15, 9);

function windowsComposerInput(text: string, imagePath: boolean): string {
  // A leading question mark opens the shortcut panel on an empty composer.
  // Codex trims the guard space at submission.
  let input = !imagePath && text.startsWith('?') ? windowsKey(0, 0, 32) : '';
  for (const character of text.replace(/\r\n?/g, '\n')) {
    if (character === '\n') {
      input += endKey + newline;
    } else if (character === '\t') {
      input += endKey + literalTab;
    } else {
      const code = character.codePointAt(0)!;
      // End closes a keyboard paste burst before Codex interprets a printable
      // shortcut. Image paths must reach its attachment detector in one burst.
      if (!imagePath && code < 128 && /[\p{P}\p{S}]/u.test(character)) input += endKey;
      input += code > 0xffff ? character : windowsKey(0, 0, code);
    }
  }
  return input;
}

/** Used by the Codex TUI input driver for message text and attachment paths. */
export async function pasteCodexText(paneId: string, text: string, options: { windowsInterop?: boolean; imagePath?: boolean } = {}) {
  const windowsInterop = options.windowsInterop ?? getCodexCliConfig().pathConfig.windowsClaude;
  await tmuxService.pasteText(paneId, windowsInterop ? windowsComposerInput(text, Boolean(options.imagePath)) : text);
}
