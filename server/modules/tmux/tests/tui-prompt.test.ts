import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isInputReady, keysForOption, parseTuiPrompt, readInputBox, unreadablePrompt } from '@/modules/tmux/tui-prompt.js';

const fixturesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const screen = (name: string) => readFileSync(path.join(fixturesDirectory, `${name}.txt`), 'utf8').split('\n');

test('Bash permission prompt: numbered options, hard-wrapped path joined without spaces', () => {
  const prompt = parseTuiPrompt(screen('bash-permission'));
  assert.ok(prompt);
  assert.equal(prompt.question, 'Do you want to proceed?');
  assert.ok(prompt.body.includes('mkdir build-out && echo done'));
  assert.deepEqual(prompt.options.map((option) => option.label), [
    'Yes',
    'Yes, and always allow access to',
    'Yes, and switch to auto mode · auto mode handles these prompts for you',
    'No',
  ]);
  assert.match(prompt.options[1].detail ?? '', /6bc5f522-f89f-41b2-8a4b-c2a6571f20bc\\scratchpad\\fixture-proj from this project$/);
  assert.equal(prompt.options[0].selected, true);
  assert.deepEqual(keysForOption(prompt, 3), ['Down', 'Down', 'Down', 'Enter']);
  assert.deepEqual(keysForOption(prompt, 0), ['Enter']);
});

test('Write permission prompt: soft-wrapped option label is joined', () => {
  const prompt = parseTuiPrompt(screen('write-permission'));
  assert.ok(prompt);
  assert.equal(prompt.question, 'Do you want to create hello.txt?');
  assert.equal(prompt.options.length, 3);
  assert.equal(
    prompt.options[1].label,
    'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
  );
  assert.equal(prompt.options[2].label, 'No');
});

test('AskUserQuestion: descriptions become details, options after a rule are kept', () => {
  const prompt = parseTuiPrompt(screen('ask-question'));
  assert.ok(prompt);
  assert.equal(prompt.question, 'Which color do you prefer?');
  assert.deepEqual(prompt.options.map((option) => option.label), ['Red', 'Green', 'Blue', 'Type something.', 'Chat about this']);
  assert.equal(prompt.options[0].detail, 'The color red');
  assert.equal(prompt.options[0].selected, true);
});

test('AskUserQuestion with previews: the box beside the options becomes the preview, not part of the labels', () => {
  const prompt = parseTuiPrompt(screen('ask-question-preview'));
  assert.ok(prompt);
  assert.equal(prompt.question, 'Which layout?');
  assert.equal(prompt.questionTabs, true);
  assert.deepEqual(prompt.options.map((option) => option.label), ['Alpha one', 'Beta two', 'Chat about this']);
  assert.deepEqual(prompt.options.map((option) => option.selected), [true, false, false]);
  assert.deepEqual(prompt.options.map((option) => option.freeText), [false, false, false], 'this layout has no "Type something." slot');
  assert.deepEqual(prompt.options.map((option) => option.detail), [null, null, null]);
  assert.deepEqual(prompt.preview, ['A line 1', 'A line 2', 'A line 3']);
  assert.deepEqual(keysForOption(prompt, 2), ['Down', 'Down', 'Enter']);
});

test('AskUserQuestion with previews in a narrow window: wrapped footer, cursor on "Chat about this"', () => {
  const prompt = parseTuiPrompt(screen('ask-question-preview-narrow-chat'));
  assert.ok(prompt);
  assert.deepEqual(prompt.options.map((option) => option.label), ['Alpha one', 'Beta two', 'Chat about this']);
  assert.deepEqual(
    prompt.options.map((option) => option.selected),
    [false, false, true],
    'the previewed option keeps its marker, but the cursor is on the last row',
  );
  assert.deepEqual(prompt.preview, ['B line 1', 'B line 2']);
  assert.deepEqual(keysForOption(prompt, 0), ['Up', 'Up', 'Enter']);
});

test('a preview option label wrapped in the narrow left column is joined back', () => {
  const lines = [
    '─'.repeat(100),
    'Pick one?',
    '> 1. A rather long first        ┌──────────┐',
    '     option label               │ preview  │',
    '  2. Short                      └──────────┘',
    '─'.repeat(100),
    '  Chat about this',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  ];
  const prompt = parseTuiPrompt(lines);
  assert.deepEqual(prompt?.options.map((option) => option.label), ['A rather long first option label', 'Short', 'Chat about this']);
  assert.deepEqual(prompt?.preview, ['preview']);
});

test('plain menus carry no preview and are never unreadable', () => {
  const prompt = parseTuiPrompt(screen('ask-question'));
  assert.deepEqual(prompt?.preview, []);
  assert.equal(prompt?.unreadable, false);
});

test('unreadablePrompt keeps the screen below the last dialog rule', () => {
  const prompt = unreadablePrompt(['old output', '─'.repeat(40), 'Some dialog', '  1) a choice   ', '', '']);
  assert.equal(prompt.unreadable, true);
  assert.deepEqual(prompt.body, ['Some dialog', '  1) a choice']);
  assert.deepEqual(prompt.options, []);
});

test('AskUserQuestion: the "Type something." slot is a free-text option, also once text is typed into it', () => {
  const placeholder = parseTuiPrompt(screen('ask-question'));
  assert.deepEqual(placeholder?.options.map((option) => option.freeText), [false, false, false, true, false]);

  const cursorOnIt = parseTuiPrompt(screen('ask-question-free-text-cursor'));
  assert.equal(cursorOnIt?.question, 'Question 2: pick A or B?');
  assert.deepEqual(cursorOnIt?.options.map((option) => option.freeText), [false, false, true, false]);

  const typed = parseTuiPrompt(screen('ask-question-free-text-typed'));
  assert.equal(typed?.options[2].label, 'typed so far');
  assert.equal(typed?.options[2].freeText, true);
});

test('AskUserQuestion review step: a menu without the key-hint footer, recognised by the question tabs', () => {
  const lines = screen('ask-question-review');
  const prompt = parseTuiPrompt(lines);
  assert.ok(prompt);
  assert.equal(prompt.question, 'Ready to submit your answers?');
  assert.ok(prompt.body.includes('→ мой собственный ответ, с запятой'));
  assert.deepEqual(prompt.options.map((option) => [option.label, option.selected, option.freeText]), [
    ['Submit answers', true, false],
    ['Cancel', false, false],
  ]);
  assert.equal(isInputReady(lines), false);
});

test('safeguard "Session paused" dialog: parsed despite no footer and a trailing status line', () => {
  const lines = screen('session-paused');
  const prompt = parseTuiPrompt(lines);
  assert.ok(prompt);
  assert.equal(prompt.safeguardPause, true);
  assert.equal(prompt.question, 'Session paused');
  assert.deepEqual(prompt.options.map((option) => [option.label, option.selected, option.freeText]), [
    ['Switch to Opus 4.8', true, false],
    ['Edit prompt and retry with Opus 5.5', false, false],
  ]);
  assert.ok(prompt.body.some((line) => line.includes('[cyber]')), 'the details stay in the body');
  assert.deepEqual(keysForOption(prompt, 0), ['Enter']);
  assert.equal(isInputReady(lines), false);
});

test('ordinary menus are not flagged as a safeguard pause', () => {
  for (const name of ['bash-permission', 'ask-question', 'trust-folder', 'multi-select']) {
    assert.equal(parseTuiPrompt(screen(name))?.safeguardPause, false, name);
  }
});

test('permission prompts have no free-text option', () => {
  for (const name of ['bash-permission', 'write-permission', 'trust-folder']) {
    assert.ok(parseTuiPrompt(screen(name))?.options.every((option) => !option.freeText), name);
  }
});

test('trust dialog: unnumbered options follow the cursor', () => {
  const prompt = parseTuiPrompt(screen('trust-folder'));
  assert.ok(prompt);
  assert.deepEqual(prompt.options.map((option) => [option.label, option.selected]), [
    ['No, exit', true],
    ['Yes, I trust this folder', false],
  ]);
  assert.ok(prompt.body.includes('Accessing workspace:'));
  assert.deepEqual(keysForOption(prompt, 1), ['Down', 'Enter']);

  const moved = parseTuiPrompt(screen('trust-folder-moved'));
  assert.equal(moved?.options[1].selected, true);
  assert.deepEqual(keysForOption(moved!, 0), ['Up', 'Enter']);
});

test('screens without a menu yield no prompt', () => {
  for (const name of ['idle-input', 'after-deny', 'final-idle', 'streaming']) {
    assert.equal(parseTuiPrompt(screen(name)), null, name);
  }
});

test('isInputReady: true for idle and busy input boxes, false under a menu or dialog', () => {
  assert.equal(isInputReady(screen('idle-input')), true);
  assert.equal(isInputReady(screen('streaming')), true);
  assert.equal(isInputReady(screen('bash-permission')), false);
  assert.equal(isInputReady(screen('trust-folder')), false);
  assert.equal(isInputReady(['', '']), false);
});

test('readInputBox: an unsent message stays readable, a paste in progress is flagged', () => {
  assert.deepEqual(readInputBox(screen('idle-input')), { text: '', pasting: false });
  assert.deepEqual(readInputBox(screen('pasting')), { text: '', pasting: true });
  const unsent = readInputBox(screen('input-unsent'));
  assert.equal(unsent?.pasting, false);
  assert.match(unsent?.text ?? '', /^What is on this screenshot\?\n\n\\wsl\.localhost\\Ubuntu\\[\s\S]*screenshot\.png$/);
  assert.equal(readInputBox(screen('bash-permission')), null);
});

test('readInputBox: a named session draws its name into the top rule, the box is still there', () => {
  assert.deepEqual(readInputBox(screen('named-session-input')), { text: '', pasting: false });
});

test('multi-select question: checkboxes become checked flags, the Next row confirms, Chat about this follows it', () => {
  const prompt = parseTuiPrompt(screen('multi-select'));
  assert.ok(prompt);
  assert.equal(prompt.question, 'Which fruits?');
  assert.equal(prompt.questionTabs, true);
  assert.ok(prompt.body.every((line) => !line.startsWith('←')), 'the tab bar is navigation, not dialog text');
  assert.deepEqual(
    prompt.options.map((option) => [option.label, option.checked, option.confirmsSelection, option.freeText]),
    [
      ['Apple', false, false, false],
      ['Banana', false, false, false],
      ['Type something', false, false, true],
      ['Next', null, true, false],
      ['Chat about this', null, false, false],
    ],
  );
  assert.equal(prompt.options[0].detail, 'Apple');
  assert.deepEqual(keysForOption(prompt, 3), ['Down', 'Down', 'Down', 'Enter']);

  const checked = parseTuiPrompt(screen('multi-select-checked'));
  assert.deepEqual(checked?.options.map((option) => option.checked), [true, false, false, null, null]);
});

test('multi-select question: the slot holding typed text stays a checked free-text slot wherever the cursor is', () => {
  const typed = parseTuiPrompt(screen('multi-select-free-text-typed'));
  assert.deepEqual(typed?.options[2], { label: 'kiwi', detail: null, selected: true, freeText: true, checked: true, confirmsSelection: false });

  const onNext = parseTuiPrompt(screen('multi-select-next'));
  assert.deepEqual(onNext?.options.map((option) => [option.label, option.selected, option.freeText]), [
    ['Apple', false, false],
    ['Banana', false, false],
    ['kiwi', false, true],
    ['Next', true, false],
    ['Chat about this', false, false],
  ]);
  const onChat = parseTuiPrompt(screen('multi-select-next').map((line) => line
    .replace(/^>(\s+Next)$/, ' $1')
    .replace(/^ {2}4\. Chat about this/, '> 4. Chat about this')));
  assert.deepEqual(onChat?.options.map((option) => option.freeText), [false, false, true, false, false]);
});

test('multi-select single question: its confirm row is Submit', () => {
  const prompt = parseTuiPrompt(screen('multi-select-submit'));
  assert.deepEqual(prompt?.options.map((option) => [option.label, option.selected, option.confirmsSelection]), [
    ['Apple', false, false],
    ['Banana', false, false],
    ['Type something', false, false],
    ['Submit', true, true],
    ['Chat about this', false, false],
  ]);
});

test('question tabs: only a question set offers switching questions', () => {
  assert.equal(parseTuiPrompt(screen('ask-question'))?.questionTabs, false);
  assert.equal(parseTuiPrompt(screen('bash-permission'))?.questionTabs, false);
  const review = parseTuiPrompt(screen('ask-question-review'));
  assert.equal(review?.questionTabs, true);
  assert.equal(review?.body[0], 'Review your answers');
  assert.deepEqual(review?.options.map((option) => option.checked), [null, null]);
});
