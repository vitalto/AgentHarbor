import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentWindowError, assertNotOpenElsewhere } from '@/modules/tmux/agent-windows.service.js';
import type { ClaudeStatus } from '@/modules/tmux/claude-status.js';

const windowsConsoleStatus: ClaudeStatus = {
  providerSessionId: 's1',
  activity: 'idle',
  pid: 1248,
  windowsPid: true,
  cwd: 'D:\\Develop\\TerminalShare',
  updatedAt: 0,
  startedAt: null,
  processCount: 1,
};

test('resuming a session that Claude already runs elsewhere is refused instead of starting a second process', () => {
  assert.throws(
    () => assertNotOpenElsewhere('s1', new Map([['s1', windowsConsoleStatus]])),
    (error: unknown) => error instanceof AgentWindowError && /Windows terminal \(claude pid 1248, D:\\Develop\\TerminalShare\)/.test(error.message),
  );
});

test('a session with no live Claude process may be resumed', () => {
  assert.doesNotThrow(() => assertNotOpenElsewhere('s1', new Map()));
  assert.doesNotThrow(() => assertNotOpenElsewhere('s2', new Map([['s1', windowsConsoleStatus]])));
});
