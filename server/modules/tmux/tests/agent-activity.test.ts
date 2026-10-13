import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUBAGENT_ACTIVE_WINDOW_MS,
  claudeProjectDirectoryName,
  findUnfinishedWork,
} from '@/modules/tmux/agent-activity.js';

const now = 1_000_000_000;
const resting = { activity: 'idle', status: 'idle' } as const;

test('a turn and a background command are unfinished work', () => {
  assert.equal(findUnfinishedWork({ activity: 'busy', status: 'busy' }, null, now), 'turn');
  assert.equal(findUnfinishedWork({ activity: 'idle', status: 'shell' }, null, now), 'background-command');
});

test('an agent waiting for an answer has finished unless its subagent still runs', () => {
  const waiting = { activity: 'waiting', status: 'waiting' } as const;
  assert.equal(findUnfinishedWork(waiting, null, now), null);
  assert.equal(findUnfinishedWork(waiting, now - 10_000, now), 'subagent');
});

test('a subagent counts as running while its transcript is still being written', () => {
  assert.equal(findUnfinishedWork(resting, now - 10_000, now), 'subagent');
  assert.equal(findUnfinishedWork(resting, now - SUBAGENT_ACTIVE_WINDOW_MS, now), null);
});

test('a resting agent without subagents has finished', () => {
  assert.equal(findUnfinishedWork(resting, null, now), null);
});

test('transcript directories are named after the cwd with every non-alphanumeric character as a dash', () => {
  assert.equal(claudeProjectDirectoryName('D:\\Develop\\SampleProject'), 'D--Develop-SampleProject');
  assert.equal(claudeProjectDirectoryName('/home/alice/sandbox'), '-home-alice-sandbox');
  assert.equal(claudeProjectDirectoryName('D:\\Проект'), 'D--------');
});
