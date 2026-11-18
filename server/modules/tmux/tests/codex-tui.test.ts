import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { pasteCodexText } from '@/modules/tmux/codex-cli.js';
import { createCodexTerminalMonitor } from '@/modules/tmux/codex-terminal-monitor.js';
import { parseCodexScreen, typeCodexInput } from '@/modules/tmux/codex-tui.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';

const base = { title: 'thread', dead: false, cursorVisible: true, cursorX: 2, cursorY: 1 };

test('Codex pastes preserve punctuation across Windows console input and native terminals', async (t) => {
  const paste = t.mock.method(tmuxService, 'pasteText', async () => {});
  const text = '> две сессии — €\n\nПерезапустить сейчас 😀';
  await pasteCodexText('%1', text, true);
  await pasteCodexText('%2', text, false);
  const [[pane, windowsInput], nativePaste] = paste.mock.calls.map((call) => call.arguments);
  assert.equal(pane, '%1');
  assert.ok(typeof windowsInput === 'string');
  assert.ok(windowsInput.startsWith('\x1b[0;0;62;1;0;1_\x1b[0;0;62;0;0;1_'));
  const decoded = windowsInput.replace(/\x1b\[0;0;(\d+);1;0;1_\x1b\[0;0;\1;0;0;1_/g,
    (_, code: string) => String.fromCharCode(Number(code)));
  assert.equal(decoded, text);
  assert.deepEqual(nativePaste, ['%2', text]);
});

test('an automatic prompt does not submit text typed by the user during its paste', async (t) => {
  let draft = '';
  t.mock.method(tmuxService, 'inspectPane', async () => ({
    ...base, lines: ['', '› ' + draft], cursorX: 2 + draft.length,
  }));
  t.mock.method(tmuxService, 'pasteText', async (_pane: string, text: string) => { draft = text + 'my draft'; });
  const enter = t.mock.method(tmuxService, 'sendKeys', async () => { draft = ''; });
  await assert.rejects(typeCodexInput('%1', 'Continue.', [], base.title, undefined, () => true));
  assert.equal(enter.mock.callCount(), 0);
  assert.match(draft, /my draft$/);
});

test('a long Windows paste can first appear after the short-prompt timeout', async (t) => {
  const text = 'повтор '.repeat(600);
  const startedAt = Date.now();
  let elapsed = 0;
  let pasted = false;
  let submitted = false;
  t.mock.method(Date, 'now', () => startedAt + elapsed);
  t.mock.method(tmuxService, 'pasteText', async () => { pasted = true; });
  t.mock.method(tmuxService, 'inspectPane', async () => {
    const visible = pasted && elapsed >= 3500 && !submitted;
    if (pasted) elapsed += 500;
    const input = visible ? '[Pasted Content]' : '';
    return { ...base, lines: ['', '› ' + input], cursorX: 2 + input.length };
  });
  t.mock.method(tmuxService, 'sendKeys', async () => { submitted = true; });
  await typeCodexInput('%1', text, [], base.title);
  assert.equal(submitted, true);
});

test('a stable partial Windows paste submits the whole multiline caption with four images once', async (t) => {
  const caption = Array.from({ length: 10 }, (_, i) => `Строка ${i} с текстом`).join('\n\n');
  const images = ['one.png', 'two.png', 'three.png', 'four.png'];
  const markers = images.map((_, index) => `[Image #${index + 1}] `).join('');
  const submitted: string[] = [];
  let draft = '';
  let pending = '';
  let pasteBurst = false;
  t.mock.method(tmuxService, 'pasteText', async (_pane: string, value: string) => {
    if (value === caption) {
      draft += value.slice(0, 6);
      pending = value.slice(6);
      pasteBurst = true;
    } else {
      assert.equal(value, images[draft.match(/\[Image/g)?.length ?? 0]);
      draft += `[Image #${images.indexOf(value) + 1}] `;
    }
  });
  t.mock.method(tmuxService, 'inspectPane', async () => {
    const lines = ('› ' + draft).split('\n');
    return { ...base, lines, cursorY: lines.length - 1, cursorX: lines.at(-1)!.length };
  });
  t.mock.method(tmuxService, 'sendKeys', async (_pane: string, keys: string[]) => {
    // ConPTY keeps delivering the paste while Codex displays only its first word.
    draft += pending;
    pending = '';
    for (const key of keys) {
      if (key === 'End') pasteBurst = false;
      else if (key === 'Enter' && pasteBurst) draft += '\n';
      else if (key === 'Enter') {
        submitted.push(draft);
        draft = '';
      } else assert.fail('Unexpected key ' + key);
    }
  });
  await typeCodexInput('%1', caption, images, base.title);
  assert.deepEqual(submitted, [markers + caption]);
});

for (const withText of [true, false]) {
  test('Codex waits out paste-burst Enter suppression for ' + (withText ? 'an image with a caption' : 'an image alone'), async (t) => {
    let draft = '';
    let lastChange = 0;
    let submitted = 0;
    let settlingReads = 0;
    t.mock.method(tmuxService, 'pasteText', async (_pane: string, value: string) => {
      draft = value === 'test.png' ? '[Image #1]' : '[Image #1] подп';
      lastChange = performance.now();
    });
    t.mock.method(tmuxService, 'inspectPane', async () => {
      if (draft.endsWith('подп')) {
        settlingReads++;
        if (settlingReads === 2) return { ...base, cursorVisible: false, lines: ['', '› ' + draft] };
        if (settlingReads === 3) {
          draft += 'ись';
          lastChange = performance.now();
        }
      }
      return { ...base, cursorX: 2 + draft.length, lines: ['', '› ' + draft] };
    });
    const enter = t.mock.method(tmuxService, 'sendKeys', async (_pane: string, keys: string[]) => {
      assert.deepEqual(keys, ['End', 'Enter']);
      if (performance.now() - lastChange <= 120) {
        draft += '\n';
        return;
      }
      assert.equal(draft, withText ? '[Image #1] подпись' : '[Image #1]');
      submitted++;
      draft = '';
    });
    await typeCodexInput('%1', withText ? 'подпись' : '', ['test.png'], base.title);
    assert.equal(submitted, 1);
    assert.equal(enter.mock.callCount(), 1);
  });
}

test('Codex reports a stuck draft when the terminal consumes Enter as a newline', async (t) => {
  let lines = ['', '›'];
  t.mock.method(tmuxService, 'inspectPane', async () => ({
    ...base, lines, cursorY: lines.length - 1, cursorX: lines.at(-1) === '› hello' ? 7 : 2,
  }));
  t.mock.method(tmuxService, 'pasteText', async () => { lines = ['', '› hello']; });
  const enter = t.mock.method(tmuxService, 'sendKeys', async () => { lines.push(''); });
  await assert.rejects(typeCodexInput('%1', 'hello', [], base.title), /did not submit/i);
  assert.equal(enter.mock.callCount(), 1);
});

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

test('queued follow-up inputs keep the activity of the Codex turn above them', () => {
  const queue = ['', '• Queued follow-up inputs', '  ? 1 question', '    shift+← to answer', '', ''];
  const capture = { ...base, cursorY: 1 + queue.length, lines: [
    '• Working (3m 06s • esc to interrupt)', ...queue, '›', '', '  ? for shortcuts',
  ] };
  assert.equal(parseCodexScreen(capture).activity, 'working');
  capture.lines[0] = '  Worked for 3m 06s';
  assert.equal(parseCodexScreen(capture).activity, 'idle');
  capture.lines.splice(3, 0, '  A queued message mentioning esc to interrupt');
  capture.cursorY++;
  assert.equal(parseCodexScreen(capture).activity, 'idle');
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

test('the Codex queue exposes unanswered questions without resetting the working clock or counting a pasted copy', () => {
  const queue = ['• Queued follow-up inputs', '  ? 2 questions', '    shift+← to answer'];
  const lines = ['◦ Working (16m 08s • esc to interrupt) · 1 b…', '', ...queue, '', '›', '', '? for shortcuts'];
  const screen = parseCodexScreen({ ...base, cursorY: 6, lines });
  assert.equal(screen.activity, 'working');
  assert.equal(screen.pendingQuestionCount, 2);
  assert.deepEqual(screen.turnStatus, { label: 'Working', elapsedSeconds: 968 });
  assert.equal(parseCodexScreen({ ...base, cursorY: 6, lines: [...lines.slice(0, 6), '› a draft', ...queue] }).pendingQuestionCount, 2);
  assert.equal(parseCodexScreen({ ...base, cursorY: 3, lines: ['› copied output', ...queue, '  shortcuts'] }).pendingQuestionCount, 0);
  assert.equal(parseCodexScreen({ ...base, cursorY: 4, lines: [...queue, '', '›'] }).activity, 'idle');
});

const questionLines = [
  '', '  Where should the', '  sample go?', '', '  › 1. First option', '    2. Second option', '',
  '  enter submit   ctrl+] skip   option 1/3', '  shift+→ main prompt', '',
];

test('a narrow native question panel exposes its wrapped title and only the choices visible in this capture', () => {
  const drawer = parseCodexScreen({ ...base, cursorVisible: false, lines: questionLines });
  assert.equal(drawer.activity, 'waiting');
  assert.equal(drawer.dialog?.question, 'Where should the sample go?');
  assert.ok(drawer.dialog.codexQuestionId);
  assert.deepEqual(drawer.dialog.options.map(({label}) => label), ['First option', 'Second option']);
  const typed = parseCodexScreen({ ...base, cursorY: 4,
    lines: ['  Can you share', '  the document?', '', '  › my existing draft', '', '  enter submit   ctrl+] skip', '  shift+→ main prompt'] });
  assert.equal(typed.dialog?.question, 'Can you share the document?');
  assert.deepEqual(typed.dialog.options, []);
});

test('opening and closing the native queue never submits; an explicit answer is sent once to the matching live question', async (t) => {
  const nativeId = '00000000-0000-4000-8000-000000000001';
  const queue = ['• Queued follow-up inputs', '  ? 1 question', '    shift+← to answer', '', '›'];
  let lines = queue;
  t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'codex', provider_session_id: nativeId }));
  t.mock.method(tmuxService, 'listPanes', async () => [{ paneId: '%1', windowName: 'codex-app', windowId: '@1', title: nativeId }]);
  t.mock.method(tmuxService, 'readWindowOption', async () => '%1');
  t.mock.method(tmuxService, 'inspectPane', async () => ({
    ...base, title: nativeId, cursorY: lines.length - 1, cursorVisible: lines === queue, lines,
  }));
  const keys: string[] = [];
  t.mock.method(tmuxService, 'sendKeys', async (_pane: string, delivered: string[]) => {
    keys.push(...delivered);
    if (delivered[0] === 'S-Left') lines = questionLines;
    if (delivered[0] === 'S-Right') lines = queue;
    if (delivered[0] === 'Down') lines = questionLines.map(line => line.replace('› 1.', '  1.').replace('  2.', '› 2.'));
    if (delivered[0] === 'Enter') lines = ['›'];
  });
  const monitor = createCodexTerminalMonitor(() => false);
  assert.equal(await monitor.focusQuestions('app', true), true);
  assert.equal(await monitor.focusQuestions('app', true), true);
  const questionId = parseCodexScreen({ ...base, lines, cursorVisible: false }).dialog?.codexQuestionId;
  assert.equal(await monitor.chooseOption('app', 1, 'previous-question'), false);
  assert.equal(await monitor.focusQuestions('app', false), true);
  assert.equal(await monitor.chooseOption('app', 1, questionId), false);
  assert.deepEqual(keys, ['S-Left', 'S-Right']);
  assert.equal(await monitor.focusQuestions('app', true), true);
  assert.equal(await monitor.chooseOption('app', 1, questionId), true);
  assert.equal(await monitor.chooseOption('app', 1, questionId), false);
  assert.equal(await monitor.focusQuestions('app', true), false);
  assert.deepEqual(keys, ['S-Left', 'S-Right', 'S-Left', 'Down', 'Enter']);
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
