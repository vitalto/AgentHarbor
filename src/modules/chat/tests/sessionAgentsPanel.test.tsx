import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

const subagents = [
  { agentId: 'a1', description: 'Прогрев шейдеров', agentType: 'general-purpose', background: true, running: true, startedAt: null, updatedAt: new Date().toISOString() },
  { agentId: 'a2', description: 'Разведка: пакет', agentType: 'Explore', background: false, running: false, startedAt: null, updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
];

vi.mock('@/shared/api', () => ({
  api: {
    sessionSubagents: vi.fn(async () => new Response(JSON.stringify({ success: true, data: subagents }))),
    subagentActivity: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { agent: { id: 'a1', status: 'running' }, activity: [], activityCount: 0 } }))),
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined }),
}));

test('shows how many subagents work, lists the running ones, and reveals finished ones on demand', { timeout: 30_000 }, async () => {
  const { default: SessionAgentsPanel } = await import('@/modules/chat/composer/SessionAgentsPanel');
  await act(async () => {
    render(<SessionAgentsPanel sessionId="s1" createDiff={() => []} />);
  });

  assert.ok(screen.getByText(/Agents · 1 working · 1 finished/));
  assert.equal(screen.queryByText('Прогрев шейдеров'), null, 'collapsed until clicked');

  fireEvent.click(screen.getByText(/Agents · 1 working/));
  assert.ok(screen.getByText('Прогрев шейдеров'));
  assert.equal(screen.queryByText('Разведка: пакет'), null, 'finished agents are folded away');

  fireEvent.click(screen.getByText('Show finished (1)'));
  assert.ok(screen.getByText('Разведка: пакет'));
});
