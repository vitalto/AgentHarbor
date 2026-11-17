import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getCodexCliConfig } from '@/modules/tmux/index.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

const exec = promisify(execFile);

/** Supplies the account status for the Codex settings and onboarding panels. */
export class CodexProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    try {
      const { executable, env } = getCodexCliConfig();
      const { stdout, stderr } = await exec(executable, ['login', 'status'], { env, timeout: 8000, windowsHide: true });
      // The CLI can include a key fragment in its status line.
      const output = stdout + stderr;
      const method = /api[ _-]?key/i.test(output) ? 'api_key' : /chatgpt/i.test(output) ? 'chatgpt' : null;
      return { provider: 'codex', installed: true, authenticated: true, email: null, method };
    } catch (error) {
      const installed = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      return { provider: 'codex', installed, authenticated: false, email: null, method: null,
        error: installed ? 'Check codex login status on the server.' : 'Codex CLI was not found.' };
    }
  }
}
