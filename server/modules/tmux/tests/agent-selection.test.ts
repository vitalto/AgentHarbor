import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isModelSwitchConfirmation,
  keepUserSelectionSettings,
  LAUNCH_DEFAULT_SELECTION,
  normalizeSelection,
  restoreSelectionSettings,
  rewritesUserSettings,
  selectionCommands,
  selectionLaunch,
} from '@/modules/tmux/agent-selection.js';

test('a launch passes only what differs from Claude\'s own settings; ultracode starts at xhigh', () => {
  assert.deepEqual(selectionLaunch(LAUNCH_DEFAULT_SELECTION), { args: [], applied: LAUNCH_DEFAULT_SELECTION });
  assert.deepEqual(selectionLaunch({ model: 'sonnet', effort: 'max' }), {
    args: ['--model', 'sonnet', '--effort', 'max'],
    applied: { model: 'sonnet', effort: 'max' },
  });
  assert.deepEqual(selectionLaunch({ model: 'default', effort: 'ultracode' }), {
    args: ['--effort', 'xhigh'],
    applied: { model: 'default', effort: 'xhigh' },
  });
});

test('unusable values keep the fallback', () => {
  const fallback = { model: 'opus', effort: 'high' };
  assert.deepEqual(normalizeSelection({ model: 'sonnet[1m]', effort: 'low' }, fallback), { model: 'sonnet[1m]', effort: 'low' });
  assert.deepEqual(normalizeSelection({ model: 'two words', effort: 'turbo' }, fallback), fallback);
  assert.deepEqual(normalizeSelection({ model: null, effort: undefined }, fallback), fallback);
  assert.deepEqual(normalizeSelection({ model: '  haiku ', effort: 'default' }, fallback), { model: 'haiku', effort: 'default' });
});

test('nothing is typed while the window already runs the selection', () => {
  assert.deepEqual(selectionCommands({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' }), []);
});

test('a model switch sets an explicit effort again, since the next model may bring its own', () => {
  assert.deepEqual(
    selectionCommands({ model: 'default', effort: 'high' }, { model: 'sonnet', effort: 'high' }),
    ['/model sonnet', '/effort high'],
  );
  assert.deepEqual(
    selectionCommands({ model: 'sonnet', effort: 'default' }, { model: 'default', effort: 'default' }),
    ['/model default'],
  );
});

test('effort changes: default is auto, ultracode is xhigh plus the switch, leaving ultracode turns it off first', () => {
  assert.deepEqual(selectionCommands({ model: 'opus', effort: 'max' }, { model: 'opus', effort: 'default' }), ['/effort auto']);
  assert.deepEqual(
    selectionCommands({ model: 'opus', effort: 'xhigh' }, { model: 'opus', effort: 'ultracode' }),
    ['/effort xhigh', '/effort ultracode on'],
  );
  assert.deepEqual(
    selectionCommands({ model: 'opus', effort: 'ultracode' }, { model: 'opus', effort: 'low' }),
    ['/effort ultracode off', '/effort low'],
  );
});

test('only /model and /effort auto rewrite the user settings file', () => {
  assert.equal(rewritesUserSettings('/model sonnet'), true);
  assert.equal(rewritesUserSettings('/effort auto'), true);
  assert.equal(rewritesUserSettings('/effort max'), false);
  assert.equal(rewritesUserSettings('/effort ultracode on'), false);
});

test('the selection keys go back as they were; other keys keep what was written meanwhile', () => {
  const snapshot = `${JSON.stringify({ model: 'opus', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }, null, 2)}\n`;
  const afterCommands = `${JSON.stringify({ model: 'sonnet', theme: 'light', modelSettings: { 'claude-opus-5-5': {} } }, null, 2)}\n`;
  const restored = restoreSelectionSettings(afterCommands, snapshot);
  assert.deepEqual(JSON.parse(restored ?? ''), {
    model: 'opus', theme: 'light', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  });
  assert.ok(restored?.endsWith('}\n'));

  const withoutModel = JSON.stringify({ theme: 'dark' });
  assert.deepEqual(JSON.parse(restoreSelectionSettings(JSON.stringify({ theme: 'dark', model: 'haiku' }), withoutModel) ?? ''), { theme: 'dark' });
  assert.equal(restoreSelectionSettings(snapshot, snapshot), null);
  assert.equal(restoreSelectionSettings('{broken', snapshot), null);
});

test('settings rewritten by the typed commands are restored once Claude has written them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ah-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'settings.json');
  await writeFile(settingsPath, `${JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2)}\n`);

  await keepUserSelectionSettings(settingsPath, async () => {
    // Claude writes its change a moment after the command was typed.
    setTimeout(() => {
      void writeFile(settingsPath, `${JSON.stringify({ model: 'sonnet', theme: 'dark' }, null, 2)}\n`);
    }, 150);
  });

  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { model: 'opus', theme: 'dark' });
});

test('the "Switch model?" confirmation is recognised with the cursor on yes', () => {
  // Captured from Claude Code 2.1.303 after /model sonnet in a conversation cached for Haiku.
  const screen = [
    '● PONG',
    '✻ Baked for 1s · done 22:14',
    '▔'.repeat(80),
    '   Switch model?',
    '   Your next response will be slower and use more tokens',
    '   This conversation is cached for the current model. Switching to Sonnet 5.5',
    '   means the full history gets re-read on your next message.',
    '   > 1. Yes, switch to Sonnet 5.5',
    '     2. No, go back',
  ];
  assert.equal(isModelSwitchConfirmation(screen), true);
  assert.equal(isModelSwitchConfirmation(screen.map((line) => line.replace('> 1.', '  1.').replace('  2.', '> 2.'))), false);
  assert.equal(isModelSwitchConfirmation(['> ', '────', '  ⏵⏵ bypass permissions on']), false);
});
