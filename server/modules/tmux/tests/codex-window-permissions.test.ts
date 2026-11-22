import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { ensureCodexWindow } from '@/modules/tmux/codex-windows.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';

test('a TUI routes approvals to review, honors a read-only host and resumes only its own thread', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ah-codex-window-'));
  const previous = { sandbox: process.env.AH_CODEX_SANDBOX_MODE, home: process.env.AH_CODEX_HOME, stateDir: process.env.AH_STATE_DIR };
  process.env.AH_CODEX_SANDBOX_MODE = 'read-only';
  process.env.AH_CODEX_HOME = home;
  process.env.AH_STATE_DIR = home;
  t.after(async () => {
    if (previous.sandbox === undefined) delete process.env.AH_CODEX_SANDBOX_MODE;
    else process.env.AH_CODEX_SANDBOX_MODE = previous.sandbox;
    if (previous.home === undefined) delete process.env.AH_CODEX_HOME;
    else process.env.AH_CODEX_HOME = previous.home;
    if (previous.stateDir === undefined) delete process.env.AH_STATE_DIR;
    else process.env.AH_STATE_DIR = previous.stateDir;
    await rm(home, { recursive: true, force: true });
  });
  const row = { provider: 'codex', project_path: "/work/it's mine", model: 'test-model', effort: 'high', provider_session_id: null as string | null };
  t.mock.method(sessionsDb, 'getSessionById', () => row);
  t.mock.method(tmuxService, 'hasSession', async () => true);
  t.mock.method(tmuxService, 'listPanes', async () => []);
  t.mock.method(tmuxService, 'inspectPane', async () => { throw new Error('Test pane closed'); });
  const launches: string[] = [];
  t.mock.method(tmuxService, 'newWindow', async ({ command, env }: Parameters<typeof tmuxService.newWindow>[0]) => {
    launches.push(command);
    assert.match(env?.AH_CODEX_TURN_STATUS ?? '', /codex-turn-status[/\\][a-f0-9]{64}\.json$/);
    return { windowId: '@1', paneId: '%1' };
  });
  t.mock.method(tmuxService, 'setWindowOption', async () => {});
  await Promise.all([ensureCodexWindow('test-app'), ensureCodexWindow('test-app')]);
  assert.equal(launches.length, 1);
  assert.match(launches[0], /'--no-daemon'/);
  for (const event of ['UserPromptSubmit', 'Stop', 'Interrupt']) assert.ok(launches[0].includes(`hooks.${event}=`));
  assert.match(launches[0], /'--sandbox' 'read-only'/);
  assert.match(launches[0], /'--model' 'test-model'/);
  assert.ok(launches[0].includes('model_reasoning_effort="high"'));
  assert.doesNotMatch(launches[0], /bypass|resume/);
  row.provider_session_id = '01999999-abcd-7123-9876-123456789abc';
  await ensureCodexWindow('test-app');
  assert.ok(launches[1].endsWith(`'resume' '${row.provider_session_id}'`));
  assert.doesNotMatch(launches[1], /--sandbox|bypass/);
  row.provider_session_id = null;
  process.env.AH_CODEX_SANDBOX_MODE = 'danger-full-access';
  await ensureCodexWindow('test-app');
  row.provider_session_id = '01999999-abcd-7123-9876-123456789abc';
  await ensureCodexWindow('test-app');
  assert.ok(launches[3].endsWith(`'resume' '${row.provider_session_id}'`));
  for (const command of launches.slice(0, 2)) {
    assert.match(command, /'--ask-for-approval' 'on-request'/);
    assert.ok(command.includes('approvals_reviewer="auto_review"'));
    assert.doesNotMatch(command, /danger-full-access|bypass|--remote/);
  }
  for (const command of launches.slice(2)) {
    assert.ok(command.includes("'--dangerously-bypass-approvals-and-sandbox'"));
    assert.doesNotMatch(command, /'--sandbox'|'--ask-for-approval'|approvals_reviewer|--remote/);
  }
});
