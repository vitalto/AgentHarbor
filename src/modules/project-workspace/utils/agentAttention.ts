import type { AgentWindow } from '@/shared/hooks/useAgentWindows';

/**
 * Sessions that just gained something to look at, from one live-agents poll to
 * the next: a turn finished (busy → idle) or Claude started waiting on a menu.
 * A session seen for the first time is only a baseline.
 */
export function sessionsNeedingAttention(
  previousActivity: ReadonlyMap<string, AgentWindow['activity']>,
  agents: AgentWindow[],
): string[] {
  return agents
    .filter((agent) => {
      const before = previousActivity.get(agent.sessionId);
      const finished = before === 'busy' && agent.activity === 'idle';
      const startedWaiting = before !== undefined && before !== 'waiting' && agent.activity === 'waiting';
      return finished || startedWaiting;
    })
    .map((agent) => agent.sessionId);
}
