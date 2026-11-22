import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { quoteForShell } from '@/modules/tmux/agent-launch.js';
import { getCodexCliConfig } from '@/modules/tmux/codex-cli.js';
import { toClaudePath } from '@/modules/tmux/path-translation.js';
import { findApplicationRoot, readObjectRecord } from '@/shared/index.js';

const events = ['UserPromptSubmit', 'Stop', 'Interrupt'] as const;
const statusVariable = 'AH_CODEX_TURN_STATUS';
const workerName = 'agentharbor-codex-turn-hook.mjs';

function statusPath(stateDir: string, appSessionId: string) {
  const filename = createHash('sha256').update(appSessionId).digest('hex') + '.json';
  return path.join(stateDir, 'codex-turn-status', filename);
}

/** The Codex pane launcher passes hooks as session flags so other applications' Codex configuration stays independent. */
export async function prepareCodexTurnHooks(appSessionId: string, config: ReturnType<typeof getCodexCliConfig>) {
  const { pathConfig } = config;
  const workerPath = path.join(pathConfig.stateDir, workerName);
  const nativeWorkerPath = toClaudePath(workerPath, pathConfig);
  const windowsShell = pathConfig.windowsClaude || process.platform === 'win32';
  if (windowsShell && /["%$`!\r\n]/.test(nativeWorkerPath)) return null;
  const destination = statusPath(pathConfig.stateDir, appSessionId);
  const appRoot = findApplicationRoot(fileURLToPath(new URL('.', import.meta.url)));
  const temporaryWorker = `${workerPath}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const script = await fs.readFile(path.join(appRoot, 'bin', workerName));
    const previous = await fs.readFile(workerPath).catch(() => null);
    if (!previous?.equals(script)) {
      await fs.writeFile(temporaryWorker, script, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporaryWorker, workerPath);
    }
  } catch (error) {
    console.warn('[AgentHarbor] Could not prepare Codex turn hooks', (error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
    return null;
  } finally {
    await fs.rm(temporaryWorker, { force: true }).catch(() => {});
  }
  const quote = windowsShell ? (input: string) => `"${input}"` : quoteForShell;
  const executable = pathConfig.windowsClaude ? 'node' : quote(process.execPath);
  const command = `${executable} ${quote(nativeWorkerPath)}`;
  const handler = `[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=3}]}]`;
  return {
    args: events.flatMap((event) => ['-c', `hooks.${event}=${handler}`]),
    env: {
      [statusVariable]: destination,
      ...(pathConfig.windowsClaude && { WSLENV: [config.env.WSLENV, `${statusVariable}/p`].filter(Boolean).join(':') }),
    },
  };
}

/** The providers runtime can check a trusted Codex hook's state for the exact turn it already saw start. */
export async function readCodexTurnHook(appSessionId: string, sessionId: string, turnId: string) {
  const { stateDir } = getCodexCliConfig().pathConfig;
  try {
    const record = readObjectRecord(JSON.parse(await fs.readFile(statusPath(stateDir, appSessionId), 'utf8')));
    if (record?.sessionId !== sessionId || record?.turnId !== turnId) return null;
    return events.find((event) => event === record.event) ?? null;
  } catch {
    return null;
  }
}
