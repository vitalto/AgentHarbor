import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { test, vi } from 'vitest';

import { AgentMoveError, type AgentWindow } from '@/shared/hooks/useAgentWindows';
import type * as AgentWindowsModuleNamespace from '@/shared/hooks/useAgentWindows';

type AgentWindowsModule = typeof AgentWindowsModuleNamespace;

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

const closeWindow = vi.fn<(sessionId: string, options: { force?: boolean }) => Promise<void>>();

vi.mock('@/shared/hooks/useAgentWindows', async (importOriginal) => ({
  ...(await importOriginal<AgentWindowsModule>()),
  useAgentWindows: () => ({ windows: agents, findWindow: () => null, closeWindow }),
}));

function OpenedSession() {
  return <div>opened {useParams().sessionId}</div>;
}

test('lists every live agent with where it runs, and opens its chat on click', async () => {
  const { default: LiveAgentsList } = await import('@/modules/live-agents/LiveAgentsList');
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

test('the × closes an agent after a confirming click; a busy outside one can be closed anyway', async () => {
  closeWindow.mockReset();
  closeWindow
    .mockRejectedValueOnce(new AgentMoveError('Claude in the other terminal (pid 1248) reports "shell"', 'AGENT_BUSY_ELSEWHERE'))
    .mockResolvedValueOnce(undefined);
  const { default: LiveAgentsList } = await import('@/modules/live-agents/LiveAgentsList');
  render(<MemoryRouter><LiveAgentsList /></MemoryRouter>);

  fireEvent.click(screen.getByLabelText('Close Claude for Windows chat'));
  assert.equal(closeWindow.mock.calls.length, 0, 'the first click only asks');
  await act(async () => { fireEvent.click(screen.getByText('Close?')); });
  assert.ok(screen.getByText(/reports "shell"/));

  await act(async () => { fireEvent.click(screen.getByText('Close anyway')); });
  assert.deepEqual(closeWindow.mock.calls, [['app-2', { force: false }], ['app-2', { force: true }]]);
  assert.equal(screen.queryByText('Close anyway'), null);
});
