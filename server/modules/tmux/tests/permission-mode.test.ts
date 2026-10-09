import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStatusLineMode } from '@/modules/tmux/permission-mode.js';

test('each mode is read from the status line Claude shows while cycling with Shift+Tab', () => {
  const screen = (status: string) => ['> ', '────', `  ${status}`];
  assert.equal(parseStatusLineMode(screen('⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent')), 'bypassPermissions');
  assert.equal(parseStatusLineMode(screen('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')), 'auto');
  assert.equal(parseStatusLineMode(screen('⏸ manual mode on · ? for shortcuts · ← 1 agent')), 'default');
  assert.equal(parseStatusLineMode(screen('⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent')), 'acceptEdits');
  assert.equal(parseStatusLineMode(screen('⏸ plan mode on (shift+tab to cycle) · ← 1 agent')), 'plan');
});

test('no mode when the status line is covered', () => {
  assert.equal(parseStatusLineMode(['  ● main', '  ( ) general-purpose  Profiling scene reload  1h 48m']), null);
});
