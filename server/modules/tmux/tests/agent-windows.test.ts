import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentWindowError, assertNotOpenElsewhere, pickProcessesOutsideTmux } from '@/modules/tmux/agent-windows.service.js';
import type { ClaudeProcess } from '@/modules/tmux/claude-status.js';

const windowsConsoleStatus: ClaudeProcess = {
  providerSessionId: 's1',
  activity: 'idle',
  status: 'idle',
  statusSince: null,
  pid: 1248,
  windowsPid: true,
  cwd: 'D:\\Develop\\TerminalShare',
  updatedAt: 0,
  startedAt: null,
};

test('resuming a session that Claude already runs elsewhere is refused instead of starting a second process', () => {
  assert.throws(
    () => assertNotOpenElsewhere([windowsConsoleStatus]),
    (error: unknown) => error instanceof AgentWindowError && /Windows terminal \(claude pid 1248, D:\\Develop\\TerminalShare\)/.test(error.message),
  );
});

test('a session with no live Claude process may be resumed', () => {
  assert.doesNotThrow(() => assertNotOpenElsewhere([]));
});

const claudeProcess = (pid: number, startedAt: number): ClaudeProcess => ({
  providerSessionId: 's1', activity: 'idle', status: 'idle', statusSince: null, pid, windowsPid: true, cwd: null, updatedAt: 0, startedAt,
});

test('the process started with the tmux pane stays; the other holder of the session is the outside one', () => {
  const windowsConsole = claudeProcess(1248, 1_000_000);
  const tmuxCopy = claudeProcess(54292, 9_001_562);
  assert.deepEqual(pickProcessesOutsideTmux([windowsConsole, tmuxCopy], 9_000_000), [windowsConsole]);
});

test('a pane whose process cannot be identified stops nothing', () => {
  const windowsConsole = claudeProcess(1248, 1_000_000);
  assert.equal(pickProcessesOutsideTmux([windowsConsole], null), null);
  assert.equal(pickProcessesOutsideTmux([windowsConsole], 5_000_000), null);
});
