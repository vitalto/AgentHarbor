import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClaudeActivity } from '@/modules/tmux/index.js';

import {
  createAgentActivityTracker,
  describeLastAssistantTurn,
} from '../services/agent-activity-notifier.service.js';

const STARTED_AT = 1000;

/** Feeds one session's readings, one check per entry at STARTED_AT + index; each entry is [activity, statusSince]. */
function feed(sequence: Array<[ClaudeActivity, number]>) {
  const tracker = createAgentActivityTracker(STARTED_AT);
  return sequence.map(([activity, statusSince], index) => tracker
    .observe(new Map([['s1', { activity, statusSince }]]), STARTED_AT + index)
    .map((transition) => transition.kind));
}

test('a turn is reported finished once idle holds for two checks', () => {
  assert.deepEqual(
    feed([['busy', 1001], ['busy', 1001], ['idle', 1002], ['idle', 1002], ['idle', 1002]]),
    [[], [], [], ['finished'], []],
  );
});

test('a single idle reading inside a turn is not a finish', () => {
  assert.deepEqual(
    feed([['busy', 1001], ['idle', 1002], ['busy', 1003], ['idle', 1004], ['idle', 1004]]),
    [[], [], [], [], ['finished']],
  );
});

test('a turn shorter than one check is seen through its status time', () => {
  assert.deepEqual(
    feed([['idle', 500], ['idle', 1001.5], ['idle', 1001.5], ['idle', 1001.5]]),
    [[], [], ['finished'], []],
  );
});

test('a session that first shows up after the start has just worked', () => {
  assert.deepEqual(feed([['idle', 1000.5], ['idle', 1000.5], ['idle', 1000.5]]), [[], ['finished'], []]);
});

test('a session resting since before the start reports nothing', () => {
  assert.deepEqual(feed([['idle', 500], ['idle', 500], ['waiting', 400], ['waiting', 400]]), [[], [], [], []]);
});

test('a question during a turn is reported, and the turn finishing after the answer is too', () => {
  assert.deepEqual(
    feed([['busy', 1001], ['waiting', 1002], ['waiting', 1002], ['busy', 1004], ['idle', 1005], ['idle', 1005]]),
    [[], ['waiting'], [], [], [], ['finished']],
  );
});

test('a second question asked between two checks is reported again', () => {
  assert.deepEqual(feed([['busy', 1001], ['waiting', 1002], ['waiting', 1003.5]]), [[], ['waiting'], ['waiting']]);
});

test('a menu dismissed into idle is not a finish', () => {
  assert.deepEqual(feed([['busy', 1001], ['waiting', 1002], ['idle', 1003], ['idle', 1003]]), [[], ['waiting'], [], []]);
});

test('a session that disappears and comes back starts over', () => {
  const tracker = createAgentActivityTracker(STARTED_AT);
  tracker.observe(new Map([['s1', { activity: 'busy', statusSince: 500 }]]), STARTED_AT);
  tracker.observe(new Map(), STARTED_AT + 1);
  assert.deepEqual(tracker.observe(new Map([['s1', { activity: 'idle', statusSince: 600 }]]), STARTED_AT + 2), []);
  assert.deepEqual(tracker.observe(new Map([['s1', { activity: 'idle', statusSince: 600 }]]), STARTED_AT + 3), []);
});

const transcript = [
  JSON.stringify({ type: 'user', message: { content: 'do it' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done:\n  the  build   passes.' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
  '{"type":"assistant","message":', // a row cut by the tail window
].join('\n');

test('a finished turn is described by the last text the agent wrote', () => {
  assert.equal(describeLastAssistantTurn(transcript, 'finished'), 'Done: the build passes.');
});

test('a waiting agent is described by its question', () => {
  const asking = `${transcript}\n${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which port?' }] } }] },
  })}`;
  assert.equal(describeLastAssistantTurn(asking, 'waiting'), 'Which port?');
});

test('long text is cut to one short line', () => {
  const long = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } });
  const description = describeLastAssistantTurn(long, 'finished')!;
  assert.equal(description.length, 160);
  assert.ok(description.endsWith('...'));
});
