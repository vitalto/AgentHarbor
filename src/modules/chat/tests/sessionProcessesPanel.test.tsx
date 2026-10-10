import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { readComposerActivity } from '@/modules/chat/utils/backgroundTasks';
import type { SessionActivity } from '@/shared/types';

const commands = [
  { taskId: 'b1', toolUseId: 't1', status: 'running', command: 'npm run deploy', description: 'Деплой обоих сайтов', startedAt: Date.now() - 65_000 },
  { taskId: 'b2', toolUseId: 't2', status: 'completed', command: 'git push', startedAt: Date.now() - 600_000 },
];
const sent: unknown[] = [];

vi.mock('@/shared/api', () => ({
  api: {
    sessionBackgroundCommands: vi.fn(async () => new Response(JSON.stringify({ success: true, data: commands }))),
    backgroundCommandOutput: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { text: 'vroomly exit=0\n', truncated: false } }))),
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ sendMessage: (message: unknown) => sent.push(message), subscribe: () => () => undefined }),
}));

test('lists running background commands as a list, opens one to its output, stops one from its ✕', { timeout: 30_000 }, async () => {
  const { default: SessionProcessesPanel } = await import('@/modules/chat/composer/SessionProcessesPanel');
  await act(async () => {
    render(<SessionProcessesPanel sessionId="s1" refreshKey={0} />);
  });

  assert.ok(screen.getByText(/Processes · 1 running · 1 finished/));
  assert.ok(screen.getByText('Деплой обоих сайтов'), 'open by default, the running command listed by its description');
  assert.ok(screen.getByText(/^1m \d+s$/), 'how long it has run');
  assert.equal(screen.queryByText('git push'), null, 'finished commands are folded away');

  await act(async () => {
    fireEvent.click(screen.getByText('Деплой обоих сайтов'));
  });
  assert.ok(screen.getByText('npm run deploy'));
  assert.ok(screen.getByText(/vroomly exit=0/));

  fireEvent.click(screen.getByLabelText('Stop'));
  assert.deepEqual(sent, [{ type: 'chat.stop-task', sessionId: 's1', taskId: 'b1' }]);

  fireEvent.click(screen.getByText('Show finished (1)'));
  assert.ok(screen.getByText('git push'), 'a command without a description goes by its command line');
});

test('the composer tab leaves command-only background work to the panel', () => {
  const commandsOnly: SessionActivity = {
    statusText: null, canInterrupt: false, startedAt: 1, background: true,
    tasks: [{ taskId: 'b1', toolUseId: 't1', taskType: 'local_bash', description: 'deploy', startedAt: 1 }],
  };
  assert.equal(readComposerActivity(commandsOnly), null);

  const withAgent: SessionActivity = {
    ...commandsOnly,
    tasks: [...(commandsOnly.tasks ?? []), { taskId: 'a1', toolUseId: 't2', taskType: 'local_agent', description: 'survey', startedAt: 2 }],
  };
  assert.equal(readComposerActivity(withAgent), withAgent);

  const turnInFlight: SessionActivity = { ...commandsOnly, background: false, canInterrupt: true };
  assert.equal(readComposerActivity(turnInFlight), turnInFlight, 'a running turn keeps its tab and Stop');
  assert.equal(readComposerActivity(null), null);
});
