import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { claudeUserHome, isClaudeUserHome } from '@/modules/tmux/agent-config.js';

const windowsClaude = { claudeHome: '/mnt/c/Users/vital/.claude', windowsClaude: true };

test("a Windows Claude's home is the folder holding its .claude config directory", () => {
  assert.equal(claudeUserHome(windowsClaude), '/mnt/c/Users/vital');
  assert.equal(claudeUserHome({ claudeHome: '/mnt/d/claude-config', windowsClaude: true }), null);
});

test("a Linux Claude with a custom config directory still lives in this user's home", () => {
  assert.equal(claudeUserHome({ claudeHome: '/srv/claude-config', windowsClaude: false }), os.homedir());
});

test('only the home folder itself counts as home, not a project under it', () => {
  assert.equal(isClaudeUserHome('/mnt/c/Users/vital', windowsClaude), true);
  assert.equal(isClaudeUserHome('/mnt/c/users/Vital/', windowsClaude), true);
  assert.equal(isClaudeUserHome('/mnt/c/Users/vital/Projects', windowsClaude), false);
  assert.equal(isClaudeUserHome('/mnt/c/Users', windowsClaude), false);
  assert.equal(isClaudeUserHome('', windowsClaude), false);
  assert.equal(isClaudeUserHome('/home/Vital', { claudeHome: '/home/vital/.claude', windowsClaude: false }), false);
});
