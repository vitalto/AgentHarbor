import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { codexRuntime, runCodexTmuxTurn, steerCodexTurn } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { tmuxService } from '@/modules/tmux/index.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

const nativeId = '01999999-abcd-7123-9876-123456789abc';
const appId = 'app-session';
const event = (type: string, payload: AnyRecord) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';

for (const scenario of ['new', 'resume', 'interrupt', 'cancel before send', 'draft', 'switched']) {
  const description = scenario === 'resume' ? 'a busy image follow-up leaves the composer ready for the next turn' : scenario;
  test('Codex TUI transport: ' + description, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ah-codex-'));
    const originalHome = process.env.AH_CODEX_HOME;
    process.env.AH_CODEX_HOME = home;
    t.after(async () => {
      if (originalHome === undefined) delete process.env.AH_CODEX_HOME;
      else process.env.AH_CODEX_HOME = originalHome;
      await rm(home, { recursive: true, force: true });
    });
    const date = new Date(parseInt(nativeId.slice(0, 13).replace('-', ''), 16)).toISOString().slice(0, 10).split('-');
    const file = path.join(home, 'sessions', ...date, 'rollout-date-' + nativeId + '.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.join(home, 'thread-writer-locks'));
    await writeFile(path.join(home, 'thread-writer-locks', nativeId + '.lock'), '');
    const session = { provider: 'codex', provider_session_id: scenario === 'new' ? null : nativeId, project_path: home,
      model: null, effort: null, jsonl_path: scenario === 'new' ? null : file };
    if (session.jsonl_path) await writeFile(file, event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old reply' }] }));
    t.mock.method(sessionsDb, 'getSessionById', () => session);
    t.mock.method(sessionsDb, 'createSession', () => { session.jsonl_path = file; return appId; });
    t.mock.method(sessionsDb, 'assignProviderSessionId', (id: string, native: string) => {
      assert.equal(id, appId);
      session.provider_session_id = native;
    });
    const pane = { windowName: 'codex-' + appId, windowId: '@1', paneId: '%1', dead: false, command: 'codex' };
    t.mock.method(tmuxService, 'listPanes', async () => [pane]);
    t.mock.method(tmuxService, 'readWindowOption', async (_id: string, name: string) =>
      name === '@agentharbor-codex-pane' ? pane.paneId : '["default","default"]');
    let draft = scenario === 'draft' ? 'already typed' : '';
    let captionPastedAt = -Infinity;
    let working = false;
    const title = scenario === 'switched' ? '01999999-1234-7456-9876-123456789abc' : nativeId.slice(0, 29) + '...';
    t.mock.method(tmuxService, 'inspectPane', async () => {
      const draftLines = draft.split('\n');
      const [firstLine, ...continuation] = draftLines;
      return {
        title, dead: false, cursorVisible: true, cursorX: 2 + draftLines.at(-1)!.length, cursorY: draftLines.length,
        lines: [working ? '• Working (1s • esc to interrupt)' : '',
          draft ? '› ' + firstLine : '› \x1b[2mAsk anything\x1b[0m', ...continuation.map((line) => '  ' + line), '', '  ? for shortcuts'],
      };
    });
    const pasted: string[] = [];
    const submittedDrafts: string[] = [];
    const keys: string[] = [];
    let acknowledgeSubmit!: () => void;
    const submitted = new Promise<void>((resolve) => { acknowledgeSubmit = resolve; });
    t.mock.method(tmuxService, 'pasteText', async (id: string, text: string) => {
      assert.equal(id, pane.paneId);
      pasted.push(text);
      draft += text.endsWith('.png') ? '[Image #1]' : text;
      if (text === 'follow-up caption') captionPastedAt = performance.now();
    });
    t.mock.method(tmuxService, 'sendKeys', async (id: string, input: string[]) => {
      assert.equal(id, pane.paneId);
      keys.push(...input);
      // While Codex is finishing a paste burst, Enter inserts a newline and the current turn can still finish.
      if (performance.now() - captionPastedAt < 120) draft += '\n';
      else {
        if (input[0] === 'Enter') submittedDrafts.push(draft);
        draft = '';
      }
      if (!working) {
        await appendFile(file, event('event_msg', { type: 'task_started', turn_id: 'turn' }));
        working = true;
        acknowledgeSubmit();
      }
      if (input[0] === 'Escape' || (scenario === 'interrupt' && keys.length === 1)) return;
      if (scenario === 'resume' && keys.length === 1) return;
      await appendFile(file, event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new reply' }] })
        + event('event_msg', { type: 'task_complete', turn_id: 'turn' }));
      working = false;
    });

    const messages: AnyRecord[] = [];
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => session.provider_session_id, resolveResumeModel: async () => 'default',
      normalizeMessage: (raw, id) => new CodexSessionsProvider().normalizeMessage(raw, id),
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }), isProviderInstalled: async () => true,
    };
    const run = runCodexTmuxTurn('line one\nline two', { sessionId: appId, images: [{ path: 'one.png' }], files: [{ path: 'notes.txt' }] }, {
      isWebSocketWriter: true, send: (msg) => messages.push(msg as AnyRecord),
    }, context);
    if (scenario === 'resume') {
      assert.equal(await steerCodexTurn(appId, 'follow-up caption', { images: [{ path: 'follow-up.png' }] }), true);
    }
    if (scenario === 'interrupt') {
      await submitted;
      assert.equal(await codexRuntime.abort(appId), true);
    }
    if (scenario === 'cancel before send') {
      assert.equal(await codexRuntime.abort(appId), true);
      await run;
      assert.deepEqual(pasted, []);
      assert.equal(messages.at(-1)?.aborted, true);
      return;
    }
    await run;
    if (scenario === 'switched' || scenario === 'draft') {
      assert.deepEqual(pasted, []);
      assert.equal(messages.at(-1)?.success, false);
      return;
    }
    assert.equal(session.provider_session_id, nativeId);
    assert.deepEqual(pasted.slice(0, 1), ['one.png']);
    assert.match(pasted[1], /line one\nline two/);
    assert.match(pasted[1], /notes\.txt/);
    if (scenario === 'interrupt') {
      assert.deepEqual(keys, ['Enter', 'Escape']);
    } else {
      assert.deepEqual(keys, scenario === 'resume' ? ['Enter', 'Enter'] : ['Enter']);
      assert.deepEqual(messages.filter((msg) => msg.kind === 'text').map((msg) => msg.content), ['new reply']);
      assert.equal(messages.at(-1)?.success, true);
    }
    assert.equal(await steerCodexTurn(appId, 'after completion', {}), false);
    if (scenario === 'resume') {
      const nextMessages: AnyRecord[] = [];
      await runCodexTmuxTurn('fixed?', { sessionId: appId }, {
        isWebSocketWriter: true, send: (msg) => nextMessages.push(msg as AnyRecord),
      }, context);
      assert.deepEqual(nextMessages.filter((msg) => msg.kind === 'error').map((msg) => msg.content), []);
      assert.equal(nextMessages.at(-1)?.success, true);
      assert.deepEqual(pasted.slice(2), ['follow-up.png', 'follow-up caption', 'fixed?']);
      assert.deepEqual(submittedDrafts.slice(1), ['[Image #1]follow-up caption', 'fixed?']);
    }
  });
}
