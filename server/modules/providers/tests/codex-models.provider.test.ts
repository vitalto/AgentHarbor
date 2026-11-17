import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderModels, parseCodexModelCatalog, readCodexLastReplySelection } from '@/modules/providers/list/codex/codex-models.provider.js';

const catalog = JSON.stringify({ models: [
  { slug: 'one', priority: 4, visibility: 'list', default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  { slug: 'hidden', priority: 0, visibility: 'hide' },
  { slug: 'two', priority: 1, display_name: 'Model Two', visibility: 'list', default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }] },
] });

test('Codex shows visible CLI models and their own effort levels', () => {
  const models = parseCodexModelCatalog(catalog);
  assert.deepEqual(models.OPTIONS.map((option) => option.value), ['default', 'one', 'two']);
  assert.equal(models.OPTIONS[2].label, 'Model Two');
  assert.equal(models.OPTIONS[0].effort?.default, 'medium');
  assert.deepEqual(models.OPTIONS[2].effort?.values, [{ value: 'medium', description: 'Balanced' }]);
  const configured = parseCodexModelCatalog(catalog, 'one');
  assert.deepEqual(configured.OPTIONS[0].effort?.values.map((level) => level.value), ['low', 'high']);
  assert.equal(parseCodexModelCatalog(catalog, 'external-id').OPTIONS[0].effort, undefined);
});

test('Codex can open the account catalog from its own cache when its CLI is offline', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ah-codex-models-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = { home: process.env.AH_CODEX_HOME, cmd: process.env.AH_CODEX_CMD };
  t.after(() => {
    if (previous.home === undefined) delete process.env.AH_CODEX_HOME;
    else process.env.AH_CODEX_HOME = previous.home;
    if (previous.cmd === undefined) delete process.env.AH_CODEX_CMD;
    else process.env.AH_CODEX_CMD = previous.cmd;
  });
  process.env.AH_CODEX_HOME = home;
  process.env.AH_CODEX_CMD = path.join(home, 'unavailable-codex');
  await writeFile(path.join(home, 'models_cache.json'), catalog);
  await writeFile(path.join(home, 'config.toml'), 'model = "one"');
  assert.equal((await new CodexProviderModels().getSupportedModels()).OPTIONS[0].effort?.default, 'low');
});

test('an unfinished Codex turn cannot change the last answering model or effort', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ah-codex-reply-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'rollout.jsonl');
  const answered = [
    { type: 'turn_context', payload: { model: 'first', effort: 'high' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'turn_context', payload: { model: 'second', effort: 'low' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ text: 'Working' }] } },
  ].map((row) => JSON.stringify(row));
  const oversizedToolResult = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300_000) } });
  await writeFile(file, [...answered, oversizedToolResult, '{"unfinished":'].join('\n'));
  assert.deepEqual(await readCodexLastReplySelection(file), { model: 'first', effort: 'high' });
  const completion = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Ready' } };
  await writeFile(file, [...answered, JSON.stringify(completion)].join('\n'));
  assert.deepEqual(await readCodexLastReplySelection(file), { model: 'second', effort: 'low' });
});
