import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import TuiPromptPanel from '@/modules/chat/composer/TuiPromptPanel';
import type { TuiPrompt } from '@/modules/chat/utils/tuiPrompt';

const bashPermission: TuiPrompt = {
  question: 'Do you want to proceed?',
  body: ['Bash command', 'mkdir build-out && echo done', 'Do you want to proceed?'],
  options: [
    { label: 'Yes', detail: null, selected: true, freeText: false },
    { label: 'Yes, and always allow access to', detail: 'C:\\proj from this project', selected: false, freeText: false },
    { label: 'No', detail: null, selected: false, freeText: false },
  ],
};

test('each TUI option is a button that reports its index', () => {
  const onChoose = vi.fn();
  render(<TuiPromptPanel prompt={bashPermission} onChoose={onChoose} onCancel={vi.fn()} />);

  assert.ok(screen.getByText('Do you want to proceed?'));
  assert.ok(screen.getByText('mkdir build-out && echo done', { exact: false }));
  assert.ok(screen.getByText('C:\\proj from this project'));

  fireEvent.click(screen.getByText('No'));
  assert.deepEqual(onChoose.mock.calls, [[2]]);
});

test('cancel sends Esc through its own callback', () => {
  const onCancel = vi.fn();
  render(<TuiPromptPanel prompt={bashPermission} onChoose={vi.fn()} onCancel={onCancel} />);
  fireEvent.click(screen.getByText('Cancel (Esc)'));
  assert.equal(onCancel.mock.calls.length, 1);
});

const safeguardPause: TuiPrompt = {
  question: 'Session paused',
  body: ['Session paused', "Opus 5.5's safeguards flagged this session.", 'Details: `[cyber]`'],
  safeguardPause: true,
  options: [
    { label: 'Switch to Opus 4.8', detail: null, selected: true, freeText: false },
    { label: 'Edit prompt and retry with Opus 5.5', detail: null, selected: false, freeText: false },
  ],
};

test('a safeguard pause shows a countdown toward its first option; choosing keeps control', () => {
  const onChoose = vi.fn();
  render(
    <TuiPromptPanel prompt={safeguardPause} autoAnswerAt={Date.now() + 42_000} onChoose={onChoose} onCancel={vi.fn()} />,
  );

  const countdown = screen.getByTestId('tui-auto-answer');
  assert.match(countdown.textContent ?? '', /Auto-selecting\s+Switch to Opus 4\.8\s+in \d+s/);

  fireEvent.click(screen.getByText('Edit prompt and retry with Opus 5.5'));
  assert.deepEqual(onChoose.mock.calls, [[1]]);
});

test('an ordinary prompt shows no auto-answer countdown even if a deadline is passed in', () => {
  render(<TuiPromptPanel prompt={bashPermission} autoAnswerAt={Date.now() + 42_000} onChoose={vi.fn()} onCancel={vi.fn()} />);
  assert.equal(screen.queryByTestId('tui-auto-answer'), null);
});

const colorQuestion: TuiPrompt = {
  question: 'Which color do you prefer?',
  body: ['Which color do you prefer?'],
  options: [
    { label: 'Red', detail: 'The color red', selected: true, freeText: false },
    { label: 'Type something.', detail: null, selected: false, freeText: true },
    { label: 'Chat about this', detail: null, selected: false, freeText: false },
  ],
};

test('the free-text option is a field: its answer is sent with the index, never an empty one', () => {
  const onChoose = vi.fn();
  render(<TuiPromptPanel prompt={colorQuestion} onChoose={onChoose} onCancel={vi.fn()} />);

  const field = screen.getByPlaceholderText('Type something.');
  const send = screen.getByRole('button', { name: 'Send answer' });
  fireEvent.click(send);
  fireEvent.change(field, { target: { value: '   ' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  assert.deepEqual(onChoose.mock.calls, []);

  fireEvent.change(field, { target: { value: 'teal, please' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  assert.deepEqual(onChoose.mock.calls, [[1, 'teal, please']]);

  fireEvent.click(screen.getByText('Chat about this'));
  assert.deepEqual(onChoose.mock.calls.at(-1), [2]);
});

const fruitsQuestion: TuiPrompt = {
  question: 'Which fruits?',
  body: ['Which fruits?'],
  questionTabs: true,
  options: [
    { label: 'Apple', detail: 'Apple', selected: true, freeText: false, checked: true, confirmsSelection: false },
    { label: 'Banana', detail: 'Banana', selected: false, freeText: false, checked: false, confirmsSelection: false },
    { label: 'kiwi', detail: null, selected: false, freeText: true, checked: true, confirmsSelection: false },
    { label: 'Next', detail: null, selected: false, freeText: false, checked: null, confirmsSelection: true },
    { label: 'Chat about this', detail: null, selected: false, freeText: false, checked: null, confirmsSelection: false },
  ],
};

test('a multi-select question shows ticks and a confirm button, and numbers only the answers', () => {
  const onChoose = vi.fn();
  render(<TuiPromptPanel prompt={fruitsQuestion} onChoose={onChoose} onCancel={vi.fn()} onQuestionStep={vi.fn()} />);

  assert.equal(screen.getByRole('checkbox', { name: /Apple/ }).getAttribute('aria-checked'), 'true');
  assert.equal(screen.getByRole('checkbox', { name: /Banana/ }).getAttribute('aria-checked'), 'false');
  assert.ok(screen.getByText('4.'), '"Chat about this" keeps its TUI number although the confirm row sits before it');

  fireEvent.click(screen.getByRole('checkbox', { name: /Banana/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  assert.deepEqual(onChoose.mock.calls, [[1], [3]]);

  const field = screen.getByPlaceholderText('kiwi');
  fireEvent.change(field, { target: { value: 'mango' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  assert.deepEqual(onChoose.mock.calls.at(-1), [2, 'mango']);
  assert.equal((field as HTMLInputElement).value, '', 'the field empties; the slot now shows the answer');
});

test('a question set can go back to an earlier question and forward again', () => {
  const onQuestionStep = vi.fn();
  render(<TuiPromptPanel prompt={fruitsQuestion} onChoose={vi.fn()} onCancel={vi.fn()} onQuestionStep={onQuestionStep} />);

  fireEvent.click(screen.getByRole('button', { name: /Previous question/ }));
  fireEvent.click(screen.getByRole('button', { name: /Next question/ }));
  assert.deepEqual(onQuestionStep.mock.calls, [['previous'], ['next']]);
});

test('menus outside a question set offer no question switching', () => {
  render(<TuiPromptPanel prompt={bashPermission} onChoose={vi.fn()} onCancel={vi.fn()} onQuestionStep={vi.fn()} />);
  assert.equal(screen.queryByRole('button', { name: /Previous question/ }), null);
});

test('a question with previews shows the previewed option as preformatted text', () => {
  const withPreview: TuiPrompt = {
    question: 'Which layout?',
    body: ['Which layout?'],
    options: [
      { label: 'Alpha one', detail: null, selected: true, freeText: false },
      { label: 'Beta two', detail: null, selected: false, freeText: false },
    ],
    preview: ['root', '├─ skills', '└─ README.md'],
  };
  render(<TuiPromptPanel prompt={withPreview} onChoose={vi.fn()} onCancel={vi.fn()} />);
  assert.equal(screen.getByTestId('tui-preview').textContent, 'root\n├─ skills\n└─ README.md');
});

test('a dialog the server could not read shows the screen and answers with raw keys', () => {
  const onKey = vi.fn();
  const onChoose = vi.fn();
  const unreadable: TuiPrompt = { question: '', body: ['A new kind of dialog', '  Press space'], options: [], unreadable: true };
  render(<TuiPromptPanel prompt={unreadable} onChoose={onChoose} onCancel={vi.fn()} onKey={onKey} />);

  assert.ok(screen.getByText('A new kind of dialog', { exact: false }));
  fireEvent.click(screen.getByText('↓'));
  fireEvent.click(screen.getByText('Enter'));
  fireEvent.click(screen.getByText('Esc'));
  assert.deepEqual(onKey.mock.calls, [['Down'], ['Enter'], ['Escape']]);
  assert.equal(onChoose.mock.calls.length, 0);
});
