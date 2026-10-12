import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getAgentConfig, type AgentConfig } from '@/modules/tmux/agent-config.js';
import { runWindowsPowerShell } from '@/modules/tmux/windows-powershell.js';

/** `waiting` = the TUI shows a permission/question menu and blocks on the user. */
export type ClaudeActivity = 'busy' | 'waiting' | 'idle';

/** One running Claude process, from its `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`. */
export type ClaudeProcess = {
  providerSessionId: string;
  activity: ClaudeActivity;
  /** Claude's own word for it (busy, waiting, idle, shell…). */
  status: string;
  /** Since when Claude has reported that status (epoch ms), if it says. */
  statusSince: number | null;
  pid: number;
  /** Windows claude.exe seen from WSL: its pid lives in another process table. */
  windowsPid: boolean;
  cwd: string | null;
  updatedAt: number;
  startedAt: number | null;
};

/** The session's most recently updated live process. */
export type ClaudeStatus = ClaudeProcess & {
  /** How many live Claude processes hold this session (more than one means a duplicate). */
  processCount: number;
};

const MAX_STATUS_FILES = 256;
const WINDOWS_PROCESS_CACHE_MS = 3000;
const TASKLIST = '/mnt/c/Windows/System32/tasklist.exe';

/** Last statuses read, for synchronous lookups from history building. */
let lastStatuses = new Map<string, ClaudeStatus>();

/** When the Claude process currently running the session started, from the most recent status read. */
export function getLiveProcessStartTime(providerSessionId: string | null | undefined): number | null {
  return providerSessionId ? lastStatuses.get(providerSessionId)?.startedAt ?? null : null;
}

/**
 * Claude writes `shell` once a turn is over (even one ended by an API error)
 * while a run_in_background command still runs — the agent itself rests; a
 * foreground command reports `busy`. Unknown words count as busy.
 */
const RESTING_STATUSES = new Set(['idle', 'shell']);

function readActivity(value: unknown): ClaudeActivity | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  if (RESTING_STATUSES.has(value)) {
    return 'idle';
  }
  return value === 'waiting' ? 'waiting' : 'busy';
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

let windowsClaudePids: { readAt: number; pids: Set<number> | null } | null = null;

/** Drops the cached claude.exe pid list, e.g. right after ending a process, so the next read asks Windows again. */
export function forgetWindowsProcessCache(): void {
  windowsClaudePids = null;
}

/**
 * Live claude.exe pids via WSL interop (works from a systemd service too), or
 * null when Windows cannot be asked — then every Windows status file is trusted.
 */
async function readWindowsClaudePids(): Promise<Set<number> | null> {
  if (windowsClaudePids && Date.now() - windowsClaudePids.readAt < WINDOWS_PROCESS_CACHE_MS) {
    return windowsClaudePids.pids;
  }
  const pids = await new Promise<Set<number> | null>((resolve) => {
    execFile(TASKLIST, ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const found = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        const pid = Number(line.split('","')[1]);
        if (Number.isInteger(pid) && pid > 0) {
          found.add(pid);
        }
      }
      resolve(found);
    });
  });
  windowsClaudePids = { readAt: Date.now(), pids };
  return pids;
}

const LIST_CLAUDE_COMMAND_LINES = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | "
  + "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine }";

/**
 * Windows claude.exe processes whose command line names the session
 * (`--resume <id>`, `--session-id <id>`). Claude writes its status file only
 * after its first activity, so a session merely opened in a Windows console is
 * found only this way. Slow (PowerShell): for one-off checks, not polling.
 */
export async function findWindowsClaudeByCommandLine(providerSessionId: string): Promise<ClaudeProcess[]> {
  const output = await runWindowsPowerShell(LIST_CLAUDE_COMMAND_LINES);
  const found: ClaudeProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [pidText, createdText, ...commandParts] = line.split('|');
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || !commandParts.join('|').includes(providerSessionId)) {
      continue;
    }
    const startedAt = Date.parse(createdText);
    found.push({
      providerSessionId,
      activity: 'idle',
      status: 'idle',
      statusSince: null,
      pid,
      windowsPid: true,
      cwd: null,
      updatedAt: 0,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
    });
  }
  return found;
}

/**
 * Every Claude process holding the session: those with a status file plus,
 * for a Windows Claude, idle ones found by their command line.
 */
export async function findSessionHolders(providerSessionId: string, config: AgentConfig = getAgentConfig()): Promise<ClaudeProcess[]> {
  const holders = (await readClaudeProcesses(config)).filter((claude) => claude.providerSessionId === providerSessionId);
  if (!config.windowsClaude) {
    return holders;
  }
  const known = new Set(holders.map((claude) => claude.pid));
  return [...holders, ...(await findWindowsClaudeByCommandLine(providerSessionId)).filter((claude) => !known.has(claude.pid))];
}

/** Every live Claude process with a status file; files left behind by crashed processes are skipped. */
export async function readClaudeProcesses(config: AgentConfig = getAgentConfig()): Promise<ClaudeProcess[]> {
  const directory = path.join(config.claudeHome, 'sessions');
  let names: string[];
  try {
    names = (await fsp.readdir(directory)).filter((name) => name.endsWith('.json')).slice(0, MAX_STATUS_FILES);
  } catch {
    return [];
  }

  const records = await Promise.all(names.map(async (name) => {
    try {
      return JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }));

  const processes: ClaudeProcess[] = [];
  let windowsPids: Set<number> | null | undefined;
  for (const record of records) {
    if (!record) {
      continue;
    }
    const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const activity = readActivity(record.status);
    const pid = typeof record.pid === 'number' ? record.pid : 0;
    if (!providerSessionId || !activity || pid <= 0) {
      continue;
    }
    const windowsPid = typeof record.pidDomain === 'string' && record.pidDomain.startsWith('win32:') && process.platform !== 'win32';
    if (windowsPid) {
      windowsPids ??= await readWindowsClaudePids();
      if (windowsPids && !windowsPids.has(pid)) {
        continue;
      }
    } else if (!processExists(pid)) {
      continue;
    }
    processes.push({
      providerSessionId,
      activity,
      status: String(record.status),
      statusSince: typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : null,
      pid,
      windowsPid,
      cwd: typeof record.cwd === 'string' ? record.cwd : null,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
    });
  }
  return processes;
}

/** Live Claude processes grouped by session id; the most recently updated process represents the session. */
export async function readClaudeStatuses(config: AgentConfig = getAgentConfig()): Promise<Map<string, ClaudeStatus>> {
  const statuses = new Map<string, ClaudeStatus>();
  for (const claude of await readClaudeProcesses(config)) {
    const existing = statuses.get(claude.providerSessionId);
    const processCount = (existing?.processCount ?? 0) + 1;
    statuses.set(
      claude.providerSessionId,
      !existing || existing.updatedAt < claude.updatedAt ? { ...claude, processCount } : { ...existing, processCount },
    );
  }
  lastStatuses = statuses;
  return statuses;
}
