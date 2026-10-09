import assert from 'node:assert/strict';

import { test } from 'vitest';

import { applyTuiEvent, type TuiSessionState } from '@/modules/chat/hooks/useTuiSessionState';

const empty: TuiSessionState = { prompt: null, screen: [] };
const prompt = { question: 'Do you want to proceed?', body: [], options: [{ label: 'Yes', detail: null, selected: true }] };

test('a prompt opens, survives screen updates, and clears', () => {
  const opened = applyTuiEvent(empty, { kind: 'tui_prompt', prompt });
  assert.equal(opened.prompt, prompt);

  const withScreen = applyTuiEvent(opened, { kind: 'tui_screen', lines: ['● Bash(ls)'] });
  assert.equal(withScreen.prompt, prompt);
  assert.deepEqual(withScreen.screen, ['● Bash(ls)']);

  const cleared = applyTuiEvent(withScreen, { kind: 'tui_prompt_cleared' });
  assert.equal(cleared.prompt, null);
  assert.deepEqual(cleared.screen, ['● Bash(ls)']);
});

test('an empty screen frame means the TUI went idle', () => {
  const busy = applyTuiEvent(empty, { kind: 'tui_screen', lines: ['thinking'] });
  assert.deepEqual(applyTuiEvent(busy, { kind: 'tui_screen', lines: [] }).screen, []);
});
