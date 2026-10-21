import fsp from 'node:fs/promises';
import path from 'node:path';

import { pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/services/notification-orchestrator.service.js';
import { findTranscriptPath, readClaudeProcesses, type ClaudeActivity, type ClaudeProcess } from '@/modules/tmux/index.js';

const CHECK_INTERVAL_MS = 3000;
/** Idle must hold this many checks in a row before a turn counts as over, so rows written at the very end are in the transcript. */
const IDLE_CHECKS_TO_FINISH = 2;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 160;

export type AgentTransition = {
  providerSessionId: string;
  kind: 'finished' | 'waiting';
  /** When the change was seen (epoch ms). */
  at: number;
};

type TrackedSession = { activity: ClaudeActivity; idleChecks: number };

/**
 * Turns successive activity readings into "finished" (busy, then idle for a
 * couple of checks) and "waiting" (busy, then a menu). A session first seen
 * busy, e.g. right after a server restart, still gets its finish reported; one
 * first seen idle or waiting is only recorded. Waiting that ends in idle means
 * someone answered or dismissed the menu and is not reported.
 */
export function createAgentActivityTracker() {
  const sessions = new Map<string, TrackedSession>();

  return {
    observe(readings: Map<string, ClaudeActivity>, now: number): AgentTransition[] {
      const transitions: AgentTransition[] = [];
      for (const providerSessionId of sessions.keys()) {
        if (!readings.has(providerSessionId)) {
          sessions.delete(providerSessionId);
        }
      }
      for (const [providerSessionId, activity] of readings) {
        const tracked = sessions.get(providerSessionId);
        if (!tracked || activity === 'busy') {
          sessions.set(providerSessionId, { activity, idleChecks: 0 });
          continue;
        }
        if (activity === 'waiting') {
          if (tracked.activity === 'busy') {
            transitions.push({ providerSessionId, kind: 'waiting', at: now });
          }
          sessions.set(providerSessionId, { activity, idleChecks: 0 });
          continue;
        }
        if (tracked.activity !== 'busy') {
          tracked.activity = 'idle';
          continue;
        }
        tracked.idleChecks += 1;
        if (tracked.idleChecks >= IDLE_CHECKS_TO_FINISH) {
          transitions.push({ providerSessionId, kind: 'finished', at: now });
          sessions.set(providerSessionId, { activity: 'idle', idleChecks: 0 });
        }
      }
      return transitions;
    },
  };
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT_CHARS ? `${collapsed.slice(0, MAX_TEXT_CHARS - 3)}...` : collapsed;
}

/**
 * What the agent last said, from the end of its transcript: the closing text
 * of a finished turn, or the question of an AskUserQuestion it waits on.
 */
export function describeLastAssistantTurn(transcriptTail: string, kind: AgentTransition['kind']): string | null {
  const lines = transcriptTail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let row: { type?: string; message?: { content?: unknown } };
    try {
      row = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) {
      continue;
    }
    for (const block of [...row.message.content].reverse()) {
      if (kind === 'waiting' && block?.type === 'tool_use' && block.name === 'AskUserQuestion') {
        const question = block.input?.questions?.[0]?.question;
        return typeof question === 'string' ? oneLine(question) : null;
      }
      if (kind === 'finished' && block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return oneLine(block.text);
      }
    }
  }
  return null;
}

async function readTranscriptTail(transcriptPath: string): Promise<string> {
  const handle = await fsp.open(transcriptPath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function notifyTransition(transition: AgentTransition, claude: ClaudeProcess | undefined): Promise<void> {
  const userIds = pushSubscriptionsDb.getSubscribedUserIds();
  if (userIds.length === 0) {
    return;
  }
  const session = sessionsDb.getSessionByProviderSessionId(transition.providerSessionId);
  const sessionName = (session && sessionsDb.getSessionName(session.session_id, 'claude'))
    || (claude?.cwd ? path.basename(claude.cwd.replace(/[\\/]+$/, '')) : null);
  const transcriptPath = claude ? await findTranscriptPath(claude) : null;
  const text = transcriptPath
    ? describeLastAssistantTurn(await readTranscriptTail(transcriptPath).catch(() => ''), transition.kind)
    : null;

  const event = createNotificationEvent({
    provider: 'claude',
    // A session AgentHarbor does not know (e.g. opened in a Windows console) has no chat to open.
    sessionId: session?.session_id ?? null,
    kind: transition.kind === 'finished' ? 'stop' : 'action_required',
    code: transition.kind === 'finished' ? 'agent.finished' : 'agent.waiting',
    meta: transition.kind === 'finished' ? { summary: text, sessionName } : { question: text, sessionName },
    requiresUserAction: transition.kind === 'waiting',
    dedupeKey: `${transition.kind}:${transition.providerSessionId}:${transition.at}`,
  });
  await Promise.all(userIds.map((userId) => notifyUserIfEnabled({ userId, event })));
}

/** Watches every Claude process on the machine (in tmux or not) and pushes when one finishes a turn or stops on a question. */
export function startAgentActivityNotifications(): void {
  const tracker = createAgentActivityTracker();
  let checking = false;
  const check = async () => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      const processes = await readClaudeProcesses();
      const newestBySession = new Map<string, ClaudeProcess>();
      for (const claude of processes) {
        const known = newestBySession.get(claude.providerSessionId);
        if (!known || known.updatedAt < claude.updatedAt) {
          newestBySession.set(claude.providerSessionId, claude);
        }
      }
      const readings = new Map([...newestBySession].map(([id, claude]) => [id, claude.activity]));
      for (const transition of tracker.observe(readings, Date.now())) {
        await notifyTransition(transition, newestBySession.get(transition.providerSessionId)).catch((error) => {
          console.error('[AgentHarbor] could not send an agent activity notification', error);
        });
      }
    } catch (error) {
      console.error('[AgentHarbor] agent activity check failed', error);
    } finally {
      checking = false;
    }
  };
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref();
}
