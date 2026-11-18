import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { createCodexTerminalMonitor } from '@/modules/tmux/codex-terminal-monitor.js';
import { parseCodexScreen } from '@/modules/tmux/codex-tui.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';

const base = { title: 'thread', dead: false, cursorVisible: true, cursorX: 2, cursorY: 1 };

test('Codex identifies the empty composer, a draft with the cursor at Home, and a native selection menu', () => {
  const placeholder = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m';
  assert.equal(parseCodexScreen({ ...base, lines: ['', placeholder, '', '  ? for shortcuts'] }).activity, 'idle');
  assert.equal(parseCodexScreen({ ...base, lines: ['', '› unsent text', '', '  project'] }).empty, false);
  const menu = parseCodexScreen({ ...base, lines: ['Select Model and Effort', '› 1. GPT', '  enter select · esc back'] });
  assert.equal(menu.activity, 'waiting');
  assert.equal(menu.composer, false);
  assert.equal(menu.dialog?.unreadable, true);
  assert.equal(parseCodexScreen({ ...base, lines: ['• Working (5s • esc to interrupt)', placeholder] }).activity, 'working');
});

test('pasted or wrapped menu instructions stay in the editable Codex draft', () => {
  for (const rows of [['› Why did I see enter continue · esc back?'], ['› Terminal output:', '  enter continue · esc back']]) {
    const draft = parseCodexScreen({ ...base, cursorY: rows.length - 1, cursorX: rows.at(-1)!.length,
      lines: [...rows, '', '  GPT-6.2-Astra high · D:\\Develop\\CardMatch'] });
    assert.equal(draft.input, rows.join('\n'));
    assert.equal(draft.empty, false);
    assert.equal(draft.dialog, null);
  }
});

test('Codex folder access exposes the scope and answers the live selection in either direction', async (t) => {
  const trust = '1. Trust and continue';
  const back = '2. Back to Agent Command Center';
  const firstRow = '› ' + trust;
  const lines = [
    '  Folder access', '  D:\\Develop\\CardMatch', '',
    '  Note: You’re in a subdirectory of a Git project. Trusting will apply to the',
    '  repository root:', '  d:\\develop\\cardmatch', '',
    '  Trust this folder? Codex can read, edit, and run files here, subject to your',
    '  permission settings. Folder settings can run code automatically, even',
    '  without a model request. Continue only if you trust these files. Your trust',
    '  decision will be saved.', '', '\x1b[1;7m' + firstRow, '\x1b[0m  ' + back, '', '  enter continue · esc back', '',
  ];
  const capture = { ...base, lines };
  const dialog = parseCodexScreen(capture).dialog;
  assert.equal(dialog?.question, 'Trust this folder?');
  assert.deepEqual(dialog.options.map(({ label, selected }) => [label, selected]), [
    ['Trust and continue', true], ['Back to Agent Command Center', false],
  ]);
  assert.match(dialog.body.join(' '), /repository root:\nd:\\develop\\cardmatch/);
  assert.match(dialog.body.join(' '), /Folder settings can run code automatically/);
  assert.equal(dialog.unreadable, false);

  t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'codex', provider_session_id: null }));
  t.mock.method(tmuxService, 'listPanes', async () => [{ paneId: '%1', windowName: 'codex-app', windowId: '@1' }]);
  t.mock.method(tmuxService, 'readWindowOption', async () => '%1');
  t.mock.method(tmuxService, 'inspectPane', async () => capture);
  const sent = t.mock.method(tmuxService, 'sendKeys', async () => {});
  const monitor = createCodexTerminalMonitor(() => false);
  assert.equal(await monitor.chooseOption('app', 1), true);
  capture.lines = lines.map((line) => line.includes(firstRow) ? '  ' + trust : line.endsWith(back) ? '› ' + back : line);
  assert.equal(await monitor.chooseOption('app', 1), true);
  assert.equal(await monitor.chooseOption('app', 0), true);
  assert.equal(await monitor.chooseOption('app', 2), false);
  capture.lines = capture.lines.map((line) => line.replace('› ', '  '));
  assert.equal(parseCodexScreen(capture).dialog?.unreadable, true);
  assert.equal(await monitor.chooseOption('app', 0), false);
  capture.lines = ['›'];
  assert.equal(await monitor.chooseOption('app', 0), false);
  assert.deepEqual(sent.mock.calls.map((call) => call.arguments), [
    ['%1', ['Down', 'Enter']], ['%1', ['Enter']], ['%1', ['Up', 'Enter']],
  ]);
});
