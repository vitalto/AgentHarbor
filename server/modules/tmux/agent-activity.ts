import fsp from 'node:fs/promises';
import path from 'node:path';

import { getAgentConfig, type AgentConfig } from '@/modules/tmux/agent-config.js';
import { readClaudeProcesses, type ClaudeProcess } from '@/modules/tmux/claude-status.js';

/**
 * A subagent whose transcript changed this recently counts as running. Claude
 * records no explicit end for a background agent, so the write rhythm (a row
 * per step, steps rarely longer than this) is the signal.
 */
export const SUBAGENT_ACTIVE_WINDOW_MS = 90_000;

/**
 * What keeps a Claude process from being done: a turn, a background command or
 * a subagent. A menu waiting for the user (status `waiting`) is not on the
 * list: permission prompts and AskUserQuestion never time out, so nothing
 * happens there until someone answers.
 */
export type UnfinishedWork = 'turn' | 'background-command' | 'subagent';

export type UnfinishedAgent = {
  providerSessionId: string;
  cwd: string | null;
  work: UnfinishedWork;
};

/** Newest modification time anywhere under `target` (a few levels deep), or null when nothing is there. */
export async function newestWrite(target: string, depth = 0): Promise<number | null> {
  const stats = await fsp.stat(target).catch(() => null);
  if (!stats) {
    return null;
  }
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }
  if (depth > 3) {
    return null;
  }
  let newest: number | null = null;
  for (const name of await fsp.readdir(target).catch(() => [] as string[])) {
    const candidate = await newestWrite(path.join(target, name), depth + 1);
    if (candidate !== null && (newest === null || candidate > newest)) {
      newest = candidate;
    }
  }
  return newest;
}

export function findUnfinishedWork(
  claude: Pick<ClaudeProcess, 'activity' | 'status'>,
  lastSubagentWriteAt: number | null,
  now: number,
): UnfinishedWork | null {
  if (claude.activity === 'busy') {
    return 'turn';
  }
  if (claude.status === 'shell') {
    return 'background-command';
  }
  if (lastSubagentWriteAt !== null && now - lastSubagentWriteAt < SUBAGENT_ACTIVE_WINDOW_MS) {
    return 'subagent';
  }
  return null;
}

/** Claude keeps a project's transcripts in a directory named after its cwd, every character but [A-Za-z0-9] turned into `-`. */
export function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const projectDirectoryBySession = new Map<string, string>();

async function findProjectDirectory(config: AgentConfig, claude: ClaudeProcess): Promise<string | null> {
  const projectsDirectory = path.join(config.claudeHome, 'projects');
  const holdsTranscript = (directory: string) => fsp.access(path.join(directory, `${claude.providerSessionId}.jsonl`))
    .then(() => true, () => false);

  const known = projectDirectoryBySession.get(claude.providerSessionId);
  if (known && await holdsTranscript(known)) {
    return known;
  }
  // A session resumed from another directory, or a cwd long enough for Claude to shorten, lives elsewhere: search them all.
  const guessed = claude.cwd ? [claudeProjectDirectoryName(claude.cwd)] : [];
  const everyProject = await fsp.readdir(projectsDirectory).catch(() => [] as string[]);
  for (const name of [...guessed, ...everyProject]) {
    const directory = path.join(projectsDirectory, name);
    if (await holdsTranscript(directory)) {
      projectDirectoryBySession.set(claude.providerSessionId, directory);
      return directory;
    }
  }
  return null;
}

/** The session's transcript file, or null when it cannot be found. */
export async function findTranscriptPath(claude: ClaudeProcess, config: AgentConfig = getAgentConfig()): Promise<string | null> {
  const projectDirectory = await findProjectDirectory(config, claude);
  return projectDirectory ? path.join(projectDirectory, `${claude.providerSessionId}.jsonl`) : null;
}

async function lastSubagentWrite(config: AgentConfig, claude: ClaudeProcess): Promise<number | null> {
  const projectDirectory = await findProjectDirectory(config, claude);
  return projectDirectory
    ? newestWrite(path.join(projectDirectory, claude.providerSessionId, 'subagents'))
    : null;
}

/** Every live Claude process on this machine (in tmux or not) that still has work going on. */
export async function findUnfinishedAgents(
  config: AgentConfig = getAgentConfig(),
  now: number = Date.now(),
): Promise<UnfinishedAgent[]> {
  const unfinished: UnfinishedAgent[] = [];
  for (const claude of await readClaudeProcesses(config)) {
    const work = findUnfinishedWork(claude, null, now)
      ?? findUnfinishedWork(claude, await lastSubagentWrite(config, claude), now);
    if (work) {
      unfinished.push({ providerSessionId: claude.providerSessionId, cwd: claude.cwd, work });
    }
  }
  return unfinished;
}
