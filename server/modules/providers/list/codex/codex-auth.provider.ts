import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

const exec = promisify(execFile);

export class CodexProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const executable = process.env.AH_CODEX_CMD || 'codex';
    try {
      const { stdout, stderr } = await exec(executable, ['login', 'status'], { timeout: 8000 });
      return { provider: 'codex', installed: true, authenticated: true, email: null, method: (stdout || stderr).trim() };
    } catch (error) {
      const installed = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      return { provider: 'codex', installed, authenticated: false, email: null, method: null,
        error: installed ? 'Check codex login status on the server.' : 'Codex CLI was not found.' };
    }
  }
}
