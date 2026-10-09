import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldCloseIdleAgent, type IdleAgentFacts } from '@/modules/tmux/idle-reaper.service.js';

const HOUR = 60 * 60_000;
const now = 10 * HOUR;
const idle = (overrides: Partial<IdleAgentFacts> = {}): IdleAgentFacts => ({
  status: { activity: 'idle', status: 'idle', statusSince: now - 2 * HOUR },
  lastWriteAt: now - 2 * HOUR,
  viewers: 0,
  now,
  idleLimitMs: HOUR,
  ...overrides,
});

test('an agent untouched for longer than the limit is closed', () => {
  assert.equal(shouldCloseIdleAgent(idle()), true);
});

test('recent writes (the turn or a subagent) keep it open', () => {
  assert.equal(shouldCloseIdleAgent(idle({ lastWriteAt: now - 10 * 60_000 })), false);
});

test('work in progress keeps it open: a turn, a menu, a background command', () => {
  assert.equal(shouldCloseIdleAgent(idle({ status: { activity: 'busy', status: 'busy', statusSince: 0 } })), false);
  assert.equal(shouldCloseIdleAgent(idle({ status: { activity: 'waiting', status: 'waiting', statusSince: 0 } })), false);
  assert.equal(shouldCloseIdleAgent(idle({ status: { activity: 'idle', status: 'shell', statusSince: 0 } })), false);
});

test('a window someone is looking at stays open', () => {
  assert.equal(shouldCloseIdleAgent(idle({ viewers: 1 })), false);
});

test('without any timestamp nothing is closed', () => {
  assert.equal(shouldCloseIdleAgent(idle({ status: null, lastWriteAt: null })), false);
});
