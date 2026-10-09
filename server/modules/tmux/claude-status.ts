import fsp from 'node:fs/promises';
import path from 'node:path';

import { getAgentConfig, type AgentConfig } from '@/modules/tmux/agent-config.js';

/** `waiting` = the TUI shows a permission/question menu and blocks on the user. */
export type ClaudeActivity = 'busy' | 'waiting' | 'idle';

export type ClaudeStatus = {
  providerSessionId: string;
  activity: ClaudeActivity;
  pid: number;
  /** Process ids from another OS (Windows claude.exe seen from WSL) cannot be probed from here. */
  probeablePid: boolean;
  updatedAt: number;
};

const MAX_STATUS_FILES = 256;

function readActivity(value: unknown): ClaudeActivity | null {
  return value === 'busy' || value === 'waiting' || value === 'idle' ? value : null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Reads Claude Code's per-process status files (`<CLAUDE_HOME>/sessions/<pid>.json`)
 * keyed by session id. When several files name one session (a crash left one
 * behind), the most recently updated wins.
 */
export async function readClaudeStatuses(config: AgentConfig = getAgentConfig()): Promise<Map<string, ClaudeStatus>> {
  const directory = path.join(config.claudeHome, 'sessions');
  let names: string[];
  try {
    names = (await fsp.readdir(directory)).filter((name) => name.endsWith('.json')).slice(0, MAX_STATUS_FILES);
  } catch {
    return new Map();
  }

  const statuses = new Map<string, ClaudeStatus>();
  await Promise.all(names.map(async (name) => {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const activity = readActivity(record.status);
    const pid = typeof record.pid === 'number' ? record.pid : 0;
    if (!providerSessionId || !activity || pid <= 0) {
      return;
    }
    const probeablePid = !(typeof record.pidDomain === 'string' && record.pidDomain.startsWith('win32:')) || process.platform === 'win32';
    if (probeablePid && !processExists(pid)) {
      return;
    }
    const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : 0;
    const existing = statuses.get(providerSessionId);
    if (!existing || existing.updatedAt < updatedAt) {
      statuses.set(providerSessionId, { providerSessionId, activity, pid, probeablePid, updatedAt });
    }
  }));
  return statuses;
}
