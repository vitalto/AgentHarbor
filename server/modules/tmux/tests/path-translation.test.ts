import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentConfig } from '@/modules/tmux/agent-config.js';
import { toClaudePath, toLocalPath } from '@/modules/tmux/path-translation.js';

const windowsClaude: AgentConfig = {
  tmuxSession: 'main',
  claudeCommand: '/mnt/c/Users/u/.local/bin/claude.exe',
  claudeArgs: '',
  idleCloseMinutes: 60,
  claudeHome: '/mnt/c/Users/u/.claude',
  stateDir: '/mnt/c/Users/u/.agentharbor',
  windowsClaude: true,
  wslDistro: 'Ubuntu',
};
const linuxClaude: AgentConfig = { ...windowsClaude, claudeCommand: 'claude', windowsClaude: false };

test('toLocalPath maps Windows paths to WSL mounts', () => {
  assert.equal(toLocalPath('D:\\Develop\\My Proj', windowsClaude), '/mnt/d/Develop/My Proj');
  assert.equal(toLocalPath('C:\\', windowsClaude), '/mnt/c');
  assert.equal(toLocalPath('c:/Users/u/.claude/x.jsonl', windowsClaude), '/mnt/c/Users/u/.claude/x.jsonl');
  assert.equal(toLocalPath('\\\\wsl.localhost\\Ubuntu\\home\\alice', windowsClaude), '/home/alice');
  assert.equal(toLocalPath('/home/alice', windowsClaude), '/home/alice');
});

test('toClaudePath maps WSL paths back to Windows', () => {
  assert.equal(toClaudePath('/mnt/d/Develop/My Proj', windowsClaude), 'D:\\Develop\\My Proj');
  assert.equal(toClaudePath('/mnt/c', windowsClaude), 'C:\\');
  assert.equal(toClaudePath('/home/alice/x', windowsClaude), '\\\\wsl.localhost\\Ubuntu\\home\\alice\\x');
  assert.equal(toClaudePath('D:\\already', windowsClaude), 'D:\\already');
});

test('both directions are identity for a Linux Claude', () => {
  assert.equal(toLocalPath('D:\\x', linuxClaude), 'D:\\x');
  assert.equal(toClaudePath('/mnt/d/x', linuxClaude), '/mnt/d/x');
});
