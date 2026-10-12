import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentWindowError, assertNotOpenElsewhere, hasTakenMessage, pickProcessesOutsideTmux } from '@/modules/tmux/agent-windows.service.js';
import type { ClaudeProcess } from '@/modules/tmux/claude-status.js';

const windowsConsoleStatus: ClaudeProcess = {
  providerSessionId: 's1',
  activity: 'idle',
  status: 'idle',
  statusSince: null,
  pid: 1248,
  windowsPid: true,
  cwd: 'D:\\Develop\\SampleProject',
  updatedAt: 0,
  startedAt: null,
};

test('resuming a session that Claude already runs elsewhere is refused instead of starting a second process', () => {
  assert.throws(
    () => assertNotOpenElsewhere([windowsConsoleStatus]),
    (error: unknown) => error instanceof AgentWindowError && /Windows terminal \(claude pid 1248, D:\\Develop\\SampleProject\)/.test(error.message),
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

const box = (text: string, pasting = false) => ({ text, pasting });

test('a message Enter only cleaned of invisible characters is still unsent', () => {
  // tmux draws the LRM/FSI/PDI Telegram puts around quoted names as U+FFFD.
  assert.equal(hasTakenMessage(box('скажи ок Добрый день'), 'скажи ок \uFFFDДобрый день\uFFFD'), false);
  assert.equal(hasTakenMessage(box('[Image #1][Pasted text #2 +37 lines]'), '[Image #1][Pasted text #2 +35 lines]'), false);
});

test('a message that left the box was taken', () => {
  assert.equal(hasTakenMessage(box(''), '[Image #1] What is this?'), true);
  assert.equal(hasTakenMessage(null, 'hello'), true);
  assert.equal(hasTakenMessage(box('Press up to edit queued messages'), 'hello'), true);
  assert.equal(hasTakenMessage(box('', true), 'hello'), false);
});
