import assert from 'node:assert/strict';
import test from 'node:test';

import { readCodexBackgroundTerminalCount } from '@/modules/tmux/codex-background-terminals.js';

const footer = '  2 background terminals running · /ps to view · /stop to close';
const inline = '• Working (2m 33s • esc to interrupt) · 1 background terminal running · /ps to …';

test('Codex displays live terminals on a dedicated idle row or inline with the running turn', () => {
  assert.equal(readCodexBackgroundTerminalCount([footer, '', '', '›'], 3), 2);
  assert.equal(readCodexBackgroundTerminalCount([inline, '', '', '›'], 3), 1);
  assert.equal(readCodexBackgroundTerminalCount([footer.slice(0, 35), '', '›'], 2), 2);
});

test('the terminal count comes from the status above the queue, outside history and the draft', () => {
  const queue = ['', '• Queued follow-up inputs', '  another question', '    shift+← to answer', '', ''];
  assert.equal(readCodexBackgroundTerminalCount([inline, ...queue, '›'], 1 + queue.length), 1);
  assert.equal(readCodexBackgroundTerminalCount(['• Worked for 4s', ...queue, '›', footer], 1 + queue.length), 0);
  assert.equal(readCodexBackgroundTerminalCount([footer, '• Command finished', '', '›'], 3), 0);
  assert.equal(readCodexBackgroundTerminalCount(['• There are 2 background terminals running', '', '›'], 2), 0);
});
