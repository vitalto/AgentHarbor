import { getAgentConfig } from '@/modules/tmux/agent-config.js';
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
