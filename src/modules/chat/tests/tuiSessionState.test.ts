import assert from 'node:assert/strict';

import { test } from 'vitest';

import { applyTuiEvent, type TuiSessionState } from '@/modules/chat/hooks/useTuiSessionState';

const empty: TuiSessionState = { prompt: null, autoAnswerAt: null, screen: [] };
const prompt = { question: 'Do you want to proceed?', body: [], options: [{ label: 'Yes', detail: null, selected: true, freeText: false }] };

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

test('a safeguard pause carries its auto-answer deadline, which clears with the prompt', () => {
  const opened = applyTuiEvent(empty, { kind: 'tui_prompt', prompt, autoAnswerAt: 1_700_000_000_000 });
  assert.equal(opened.autoAnswerAt, 1_700_000_000_000);

  const reopened = applyTuiEvent(opened, { kind: 'tui_prompt', prompt });
  assert.equal(reopened.autoAnswerAt, null, 'an ordinary prompt has no deadline');

  assert.equal(applyTuiEvent(opened, { kind: 'tui_prompt_cleared' }).autoAnswerAt, null);
});

test('an empty screen frame means the TUI went idle', () => {
  const busy = applyTuiEvent(empty, { kind: 'tui_screen', lines: ['thinking'] });
  assert.deepEqual(applyTuiEvent(busy, { kind: 'tui_screen', lines: [] }).screen, []);
});

test('only the spinner word of the TUI screen becomes the activity label', async () => {
  const { extractTuiActivity } = await import('@/modules/chat/utils/tuiPrompt');
  assert.equal(extractTuiActivity(['> Write a poem', '* Kneading… (3s · thinking with high effort)']), 'Kneading…');
  assert.equal(extractTuiActivity(['● Bash(ls)', '✻ Running tests… (12s · ↓ 2.1k tokens)', '  ⎿  ok']), 'Running tests…');
  assert.equal(extractTuiActivity(['✻ Cogitated for 1s · done 12:30', '> ']), null);
  assert.equal(
    extractTuiActivity(['● Bash(cd "D:/Develop/Unity/Floor 7" && git status --short | head -20; git log --oneline -4 | cut -c1-110…']),
    null,
    'a tool call cut short with an ellipsis is not the spinner',
  );
  assert.equal(extractTuiActivity(['● Bash(git status…)', '✶ Running git status… (4s)']), 'Running git status…');
});
