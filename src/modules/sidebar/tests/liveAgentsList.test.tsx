import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { test, vi } from 'vitest';

import type { AgentWindow } from '@/shared/hooks/useAgentWindows';

const agents: AgentWindow[] = [
  {
    sessionId: 'app-1', providerSessionId: 'p-1', title: 'Fix the parser', projectPath: '/mnt/d/Develop/AgentHarbor',
    location: 'tmux', windowName: 'AgentHarbor', pid: null, activity: 'waiting', duplicateProcesses: false,
  },
  {
    sessionId: 'app-2', providerSessionId: 'p-2', title: 'Windows chat', projectPath: '/mnt/d/Develop/TerminalShare',
    location: 'windows', windowName: null, pid: 1248, activity: 'idle', duplicateProcesses: false,
  },
];

vi.mock('@/shared/hooks/useAgentWindows', () => ({
  useAgentWindows: () => ({ windows: agents, findWindow: () => null }),
}));

function OpenedSession() {
  return <div>opened {useParams().sessionId}</div>;
}

test('lists every live agent with where it runs, and opens its chat on click', async () => {
  const { default: LiveAgentsList } = await import('@/modules/sidebar/LiveAgentsList');
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<LiveAgentsList />} />
        <Route path="/session/:sessionId" element={<OpenedSession />} />
      </Routes>
    </MemoryRouter>,
  );

  assert.ok(screen.getByText('Live agents · 2'));
  assert.ok(screen.getByText(/AgentHarbor · waiting for your answer/));
  assert.ok(screen.getByText(/TerminalShare · outside tmux · idle/));

  fireEvent.click(screen.getByText('Windows chat'));
  assert.ok(screen.getByText('opened app-2'));
});
