import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import OutsideTmuxNotice from '@/modules/chat/composer/OutsideTmuxNotice';
import { AgentMoveError, type AgentWindow } from '@/shared/hooks/useAgentWindows';

const duplicate: AgentWindow = {
  sessionId: 'app-1', providerSessionId: 'p-1', title: 'Chat', projectPath: '/mnt/d/Develop/SampleProject',
  location: 'tmux', windowName: 'SampleProject', pid: null, activity: 'busy', duplicateProcesses: true,
};

test('a move refused because the other Claude is busy can be forced by the user', async () => {
  const onMove = vi.fn<(options: { force?: boolean }) => Promise<void>>()
    .mockRejectedValueOnce(new AgentMoveError('Claude in the other terminal (pid 1248) reports "shell"', 'AGENT_BUSY_ELSEWHERE'))
    .mockResolvedValueOnce(undefined);
  render(<OutsideTmuxNotice agent={duplicate} hasPendingMessage={false} onMove={onMove} onMoveAndSend={vi.fn()} />);

  assert.equal(screen.queryByText('Close it anyway'), null);
  await act(async () => { fireEvent.click(screen.getByText('Close the other copy')); });
  assert.ok(screen.getByText(/pid 1248\) reports "shell"/));

  await act(async () => { fireEvent.click(screen.getByText('Close it anyway')); });
  assert.deepEqual(onMove.mock.calls, [[{ force: false }], [{ force: true }]]);
  assert.equal(screen.queryByText('Close it anyway'), null);
});

test('other failures do not offer forcing', async () => {
  const onMove = vi.fn().mockRejectedValueOnce(new AgentMoveError('Could not tell which Claude process belongs to the tmux window', 'AGENT_MOVE_FAILED'));
  render(<OutsideTmuxNotice agent={duplicate} hasPendingMessage={false} onMove={onMove} onMoveAndSend={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByText('Close the other copy')); });
  assert.equal(screen.queryByText('Close it anyway'), null);
});
