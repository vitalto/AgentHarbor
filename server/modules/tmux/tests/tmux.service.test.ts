import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { createTmuxService } from '@/modules/tmux/tmux.service.js';

const tmux = createTmuxService({ socketName: `ah-test-${process.pid}`, session: 't' });

async function waitForScreen(paneId: string, predicate: (screen: string) => boolean): Promise<string> {
  let screen = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    screen = (await tmux.capturePane(paneId)).join('\n');
    if (predicate(screen)) {
      return screen;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return screen;
}

test('tmux adapter round-trips windows, pasted text and keys', async (t) => {
  await tmux.startDetachedSession(os.tmpdir());
  t.after(() => tmux.killServer());

  assert.equal(await tmux.hasSession(), true);

  const pane = await tmux.newWindow({ cwd: os.tmpdir(), name: 'agent', command: 'cat', env: { AH_TEST: '1' } });
  assert.match(pane.paneId, /^%\d+$/);
  assert.equal(pane.windowName, 'agent');

  const tricky = 'say "quotes" $HOME `tick` юникод\nline2';
  await tmux.pasteText(pane.paneId, tricky);
  await tmux.sendKeys(pane.paneId, ['Enter']);
  const screen = await waitForScreen(pane.paneId, (text) => text.includes('line2'));
  assert.ok(screen.includes('say "quotes" $HOME `tick` юникод'), screen);
  assert.ok(screen.includes('line2'), screen);

  const panes = await tmux.listPanes();
  assert.ok(panes.some((candidate) => candidate.paneId === pane.paneId && candidate.windowName === 'agent'));

  await tmux.killWindow(pane.windowId);
  const remaining = await tmux.listPanes();
  assert.ok(!remaining.some((candidate) => candidate.paneId === pane.paneId));
});

test('hasSession is false when the server is not running', async () => {
  const missing = createTmuxService({ socketName: `ah-missing-${process.pid}`, session: 'nope' });
  assert.equal(await missing.hasSession(), false);
  assert.deepEqual(await missing.listPanes(), []);
});

test('inside tmux, commands address the server named by $TMUX explicitly', () => {
  const previousTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
  try {
    assert.deepEqual(createTmuxService().socketArgs(), ['-S', '/tmp/tmux-1000/default']);
    assert.deepEqual(createTmuxService({ socketName: 'x' }).socketArgs(), ['-L', 'x']);
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
  }
});
