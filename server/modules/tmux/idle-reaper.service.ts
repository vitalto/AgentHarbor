import path from 'node:path';

import { newestWrite } from '@/modules/tmux/agent-activity.js';
import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { readClaudeProcesses, type ClaudeProcess } from '@/modules/tmux/claude-status.js';
import { paneRegistry, type PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';
import { readLastTranscriptEntryTime } from '@/shared/utils.js';

// Short against the limit (minutes, user-set), so a window closes close to the time the user chose.
const SWEEP_INTERVAL_MS = 60_000;

export type IdleAgentFacts = {
  /** Claude's own status for the window's session, if it wrote one. */
  status: Pick<ClaudeProcess, 'activity' | 'status' | 'statusSince'> | null;
  /** Newest timed transcript entry or subagent transcript write (epoch ms). */
  lastWriteAt: number | null;
  /** Attached clients showing this window (browser terminals, the phone on main). */
  viewers: number;
  now: number;
  idleLimitMs: number;
};

/**
 * Whether an agent window has sat unused long enough to close. Closing ends
 * the Claude process only; the conversation is resumed on the next message.
 * Anything still going on keeps it: a turn, a menu waiting for an answer, a
 * background command (`shell`) or subagent, or someone looking at the window.
 */
export function shouldCloseIdleAgent(facts: IdleAgentFacts): boolean {
  if (facts.viewers > 0) {
    return false;
  }
  if (facts.status && (facts.status.activity !== 'idle' || facts.status.status === 'shell')) {
    return false;
  }
  const lastActiveAt = Math.max(facts.lastWriteAt ?? 0, facts.status?.statusSince ?? 0);
  return lastActiveAt > 0 && facts.now - lastActiveAt >= facts.idleLimitMs;
}

async function lastWriteOf(pane: PaneSession): Promise<number | null> {
  if (!pane.transcriptPath || !pane.providerSessionId) {
    return null;
  }
  const subagentsDirectory = path.join(path.dirname(pane.transcriptPath), pane.providerSessionId, 'subagents');
  // Not the transcript's mtime: Claude rewrites its metadata block hourly, which would keep every window alive.
  const lastEntryTime = readLastTranscriptEntryTime(pane.transcriptPath).then((time) => time?.getTime() ?? null);
  const writes = await Promise.all([lastEntryTime, newestWrite(subagentsDirectory)]);
  const known = writes.filter((write): write is number => write !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

/** Closes registered Claude windows idle for longer than the idle-close setting (0 disables). */
export async function sweepIdleAgents(): Promise<string[]> {
  const idleLimitMs = getAgentConfig().idleCloseMinutes * 60_000;
  if (idleLimitMs <= 0) {
    return [];
  }
  const [panes, processes] = await Promise.all([paneRegistry.refresh(), readClaudeProcesses()]);
  const closed: string[] = [];
  for (const pane of panes) {
    if (!pane.registered || !pane.providerSessionId) {
      continue;
    }
    const status = processes
      .filter((claude) => claude.providerSessionId === pane.providerSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const facts: IdleAgentFacts = {
      status,
      lastWriteAt: await lastWriteOf(pane),
      viewers: await tmuxService.countViewers(pane.pane.windowId),
      now: Date.now(),
      idleLimitMs,
    };
    if (shouldCloseIdleAgent(facts)) {
      await tmuxService.killWindow(pane.pane.windowId).catch(() => undefined);
      closed.push(pane.pane.windowName);
    }
  }
  if (closed.length > 0) {
    console.log(`[AgentHarbor] closed idle Claude windows: ${closed.join(', ')}`);
  }
  return closed;
}

export function startIdleReaper(): void {
  setInterval(() => void sweepIdleAgents().catch((error) => console.error('[AgentHarbor] idle sweep failed', error)), SWEEP_INTERVAL_MS).unref();
}
