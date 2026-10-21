import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClaudeActivity } from '@/modules/tmux/index.js';

import {
  createAgentActivityTracker,
  describeLastAssistantTurn,
} from '../services/agent-activity-notifier.service.js';

function feed(sequence: ClaudeActivity[]) {
  const tracker = createAgentActivityTracker();
  return sequence.map((activity, index) => tracker.observe(new Map([['s1', activity]]), index).map((transition) => transition.kind));
}

test('a turn is reported finished once idle holds for two checks', () => {
  assert.deepEqual(feed(['busy', 'busy', 'idle', 'idle', 'idle']), [[], [], [], ['finished'], []]);
});

test('a single idle reading inside a turn is not a finish', () => {
  assert.deepEqual(feed(['busy', 'idle', 'busy', 'idle', 'idle']), [[], [], [], [], ['finished']]);
});

test('a session first seen idle or waiting reports nothing until it works', () => {
  assert.deepEqual(feed(['idle', 'idle', 'waiting', 'idle', 'idle']), [[], [], [], [], []]);
});

test('a question during a turn is reported, and the turn finishing after the answer is too', () => {
  assert.deepEqual(feed(['busy', 'waiting', 'waiting', 'busy', 'idle', 'idle']), [[], ['waiting'], [], [], [], ['finished']]);
});

test('a menu dismissed into idle is not a finish', () => {
  assert.deepEqual(feed(['busy', 'waiting', 'idle', 'idle']), [[], ['waiting'], [], []]);
});

test('a session that disappears and comes back starts over', () => {
  const tracker = createAgentActivityTracker();
  tracker.observe(new Map([['s1', 'busy']]), 0);
  tracker.observe(new Map(), 1);
  assert.deepEqual(tracker.observe(new Map([['s1', 'idle']]), 2), []);
  assert.deepEqual(tracker.observe(new Map([['s1', 'idle']]), 3), []);
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
