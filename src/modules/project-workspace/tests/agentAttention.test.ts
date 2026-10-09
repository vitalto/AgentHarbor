import assert from 'node:assert/strict';

import { test } from 'vitest';

import { sessionsNeedingAttention } from '@/modules/project-workspace/utils/agentAttention';
import type { AgentWindow } from '@/shared/hooks/useAgentWindows';

const agent = (sessionId: string, activity: AgentWindow['activity']): AgentWindow => ({
  sessionId, providerSessionId: sessionId, title: null, projectPath: null, location: 'tmux',
  windowName: sessionId, pid: null, activity, duplicateProcesses: false,
});

test('a session that keeps working needs no attention; one that finishes or starts waiting does', () => {
  const previous = new Map<string, AgentWindow['activity']>([['working', 'busy'], ['done', 'busy'], ['asks', 'busy'], ['quiet', 'idle']]);
  const now = [agent('working', 'busy'), agent('done', 'idle'), agent('asks', 'waiting'), agent('quiet', 'idle'), agent('new', 'waiting')];
  assert.deepEqual(sessionsNeedingAttention(previous, now), ['done', 'asks']);
});
