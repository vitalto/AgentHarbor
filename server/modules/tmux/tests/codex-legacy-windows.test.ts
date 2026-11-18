import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { findCodexWindow, listCodexLiveThreads, waitForCodexComposer } from '@/modules/tmux/codex-windows.service.js';
import { tmuxService, type AgentPane } from '@/modules/tmux/tmux.service.js';

const initialId = '01999999-abcd-7123-9876-123456789abc';
const otherId = '01999999-abcd-7123-bbbb-123456789abc';
const legacyPane: AgentPane = {
  windowName: 'codex-original', windowId: '@3', paneId: '%4', panePid: 1, cwd: '/repo', dead: false,
  command: "exec 'codex' '--remote' 'unix://' 'resume' '" + initialId + "'", currentCommand: 'init', title: 'host',
};
const placeholder = '› \x1b[2mAsk anything\x1b[0m';

test('listing and opening recognize the same legacy pane and exclude split panes and unowned locks', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ah-legacy-pane-'));
  const originalHome = process.env.AH_CODEX_HOME;
  process.env.AH_CODEX_HOME = home;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.AH_CODEX_HOME;
    else process.env.AH_CODEX_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  const split = { ...legacyPane, paneId: '%5', command: 'bash' };
  const missingTag = { ...legacyPane, windowId: '@4', paneId: '%6' };
  const wrongLaunch = { ...legacyPane, windowId: '@5', paneId: '%7', command: 'echo ' + initialId };
  const panes = [split, missingTag, wrongLaunch, legacyPane];
  t.mock.method(sessionsDb, 'getSessionById', (id: string) => ({ provider: 'codex', provider_session_id: id === 'original' ? initialId : otherId }));
  t.mock.method(sessionsDb, 'getSessionByProviderSessionId', () => null);
  t.mock.method(tmuxService, 'listPanes', async () => panes);
  let observed: string | null = null;
  t.mock.method(tmuxService, 'readWindowOption', async (window: string, name: string) => {
    if (window === missingTag.windowId) return null;
    if (name === '@agentharbor-codex-thread') return initialId;
    return name === '@agentharbor-codex-current-thread' ? observed : null;
  });
  t.mock.method(tmuxService, 'inspectPane', async (id: string) => {
    assert.equal(id, legacyPane.paneId);
    return { lines: [placeholder], title: 'host', dead: false, cursorVisible: true, cursorX: 2, cursorY: 0 };
  });
  const live = await listCodexLiveThreads();
  assert.deepEqual(live.map((entry) => [entry.providerSessionId, entry.pane?.paneId, entry.activity]), [[initialId, '%4', 'idle']]);
  assert.equal((await findCodexWindow('original'))?.pane.paneId, '%4');
  assert.equal(await findCodexWindow('other'), null);
  assert.equal(await findCodexWindow('original', [split, missingTag, wrongLaunch]), null);

  observed = otherId;
  assert.equal(await findCodexWindow('original'), null);
  assert.equal((await findCodexWindow('other'))?.pane.paneId, '%4');
  assert.equal((await findCodexWindow('original', [{ ...legacyPane, title: initialId }]))?.pane.paneId, '%4');
});

for (const scenario of ['matching', 'switched', 'draft', 'busy'] as const) {
  test('legacy Codex composer verifies native identity: ' + scenario, async (t) => {
    const actualId = scenario === 'switched' ? otherId : initialId;
    let draft = scenario === 'draft' ? 'unfinished' : '';
    let statusVisible = false;
    const pasted: string[] = [];
    const observed: string[] = [];
    t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'codex', provider_session_id: initialId }));
    t.mock.method(tmuxService, 'inspectPane', async () => ({
      title: 'host', dead: false, cursorVisible: true, cursorX: 2 + draft.length, cursorY: 1,
      lines: [scenario === 'busy' ? 'working · esc to interrupt' : '', draft ? '› ' + draft : placeholder],
    }));
    t.mock.method(tmuxService, 'capturePane', async () => statusVisible
      ? ['  Session:', '    ' + actualId.slice(0, 17) + '     ' + actualId.slice(17), '  Token usage: 100', '› Ask anything']
      : ['› Ask anything']);
    t.mock.method(tmuxService, 'pasteText', async (_pane: string, text: string) => { pasted.push(text); draft = text; });
    t.mock.method(tmuxService, 'sendKeys', async (_pane: string, keys: string[]) => {
      assert.deepEqual(keys, ['Enter']);
      assert.equal(draft, '/status');
      draft = '';
      statusVisible = true;
    });
    t.mock.method(tmuxService, 'setWindowOption', async (_win: string, key: string, id: string) => {
      assert.equal(key, '@agentharbor-codex-current-thread');
      observed.push(id);
    });
    const result = waitForCodexComposer('original', legacyPane, new AbortController().signal, initialId);
    if (scenario === 'matching') assert.equal((await result).providerSessionId, initialId);
    else await assert.rejects(result, scenario === 'switched' ? /different Codex session/ : scenario === 'draft' ? /draft/ : /turn to finish/);
    assert.deepEqual(pasted, scenario === 'busy' || scenario === 'draft' ? [] : ['/status']);
    assert.deepEqual(observed, scenario === 'switched' ? [otherId] : []);
  });
}
