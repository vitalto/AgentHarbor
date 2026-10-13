import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatBackgroundReminder,
  remindersDueAfter,
  settleSessionReminders,
  type RunningCommand,
} from '@/modules/providers/services/background-command-reminder.service.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test('reminders fall due at 1, 3, 7 and 15 intervals after the start: each gap doubles', () => {
  assert.equal(remindersDueAfter(59 * MINUTE, HOUR), 0);
  assert.equal(remindersDueAfter(HOUR, HOUR), 1);
  assert.equal(remindersDueAfter(3 * HOUR - 1, HOUR), 1);
  assert.equal(remindersDueAfter(3 * HOUR, HOUR), 2);
  assert.equal(remindersDueAfter(7 * HOUR, HOUR), 3);
  assert.equal(remindersDueAfter(15 * HOUR, HOUR), 4);
});

test('an interval of 0 turns reminders off', () => {
  assert.equal(remindersDueAfter(100 * HOUR, 0), 0);
});

const now = 20 * HOUR;
const command = (taskId: string, runningMs: number): RunningCommand => ({
  taskId,
  command: `sleep ${taskId}`,
  startedAt: now - runningMs,
});

test('a command is due once per reminder it has not been sent yet', () => {
  const sent = new Map([['old', 1]]);
  const { due, counts } = settleSessionReminders(sent, [command('old', 2 * HOUR), command('new', HOUR)], now, HOUR);
  assert.deepEqual(due.map((entry) => entry.taskId), ['new']);
  assert.deepEqual([...counts], [['old', 1], ['new', 1]]);
});

test('the next reminder of an already reminded command comes after a doubled gap', () => {
  const { due } = settleSessionReminders(new Map([['job', 1]]), [command('job', 3 * HOUR)], now, HOUR);
  assert.deepEqual(due.map((entry) => entry.taskId), ['job']);
});

test('commands that ended are forgotten', () => {
  const { counts } = settleSessionReminders(new Map([['gone', 2]]), [command('job', 10 * MINUTE)], now, HOUR);
  assert.deepEqual([...counts], [['job', 0]]);
});

test('one command: a single short line with its running time and command', () => {
  assert.equal(
    formatBackgroundReminder([command('waiter', HOUR + 4 * MINUTE)], now),
    '[AgentHarbor] Background command running 1h 04m: `sleep waiter`. Intended? If stuck, stop it.',
  );
});

test('several commands: one line each', () => {
  assert.equal(
    formatBackgroundReminder([command('a', 3 * HOUR), command('b', 75 * MINUTE)], now),
    '[AgentHarbor] Background commands running long:\n- 3h: `sleep a`\n- 1h 15m: `sleep b`\nIntended? If stuck, stop them.',
  );
});

test('a long or multi-line command is flattened and cut, and backticks cannot break the code span', () => {
  const longCommand = `until grep -q "smoke" out.txt\ndo sleep 10; done; echo \`date\` ${'x'.repeat(200)}`;
  const text = formatBackgroundReminder([{ taskId: 'w', command: longCommand, startedAt: now - HOUR }], now);
  const quoted = /`([^`]*)`/.exec(text)?.[1] ?? '';
  assert.ok(quoted.startsWith('until grep -q "smoke" out.txt do sleep 10; done; echo \'date\''));
  assert.ok(quoted.endsWith('…'));
  assert.ok(quoted.length <= 120);
});
