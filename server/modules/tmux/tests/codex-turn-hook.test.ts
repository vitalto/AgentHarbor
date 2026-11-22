import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findApplicationRoot } from '@/shared/index.js';

test('the Codex hook records only the latest lifecycle event and never writes prompt text', async (t) => {
  const root = findApplicationRoot(fileURLToPath(new URL('.', import.meta.url)));
  const script = path.join(root, 'bin', 'agentharbor-codex-turn-hook.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ah-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'turn.json');
  function runHook(input: string) {
    const result = spawnSync(process.execPath, [script], {
      input, encoding: 'utf8', env: { ...process.env, AH_CODEX_TURN_STATUS: destination },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  for (const event of ['UserPromptSubmit', 'Stop', 'Interrupt']) {
    runHook(JSON.stringify({ hook_event_name: event, session_id: 'session', turn_id: 'turn', prompt: 'private content' }));
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { sessionId: 'session', turnId: 'turn', event });
  }
  runHook('{"broken');
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { sessionId: 'session', turnId: 'turn', event: 'Interrupt' });
});
