import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isInputReady, keysForOption, parseTuiPrompt } from '@/modules/tmux/tui-prompt.js';

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
