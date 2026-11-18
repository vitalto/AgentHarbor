import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexSessionsProvider, readCodexRollout } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord } from '@/shared/index.js';

const timestamp = '2026-11-18T13:43:28.638Z';

function response(payload: AnyRecord) {
  return { type: 'response_item', timestamp, payload };
}

function assistant(text: string, id?: string) {
  return response({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], id });
}

function event(payload: AnyRecord) {
  return { type: 'event_msg', timestamp, payload };
}

async function* entries(rows: AnyRecord[]) {
  yield* rows;
}

async function readLiveAndSaved(tail: AnyRecord[], prefix: AnyRecord[] = []) {
  const provider = new CodexSessionsProvider();
  const normalize = (row: AnyRecord) => provider.normalizeMessage(row, 'session');
  const live: ReturnType<typeof normalize> = [];
  await readCodexRollout(entries(tail), undefined, row => live.push(...normalize(row)));
  const history = await readCodexRollout(entries([...prefix, ...tail]));
  return { live, saved: history.messages.flatMap(normalize) };
}

test('assistant messages, reasoning, and status events retain the Codex item ID', async () => {
  const { live, saved } = await readLiveAndSaved([
    assistant('Same answer', 'first-answer'),
    assistant('Same answer', 'second-answer'),
    response({ type: 'reasoning', id: 'thought', summary: [{ text: 'Review' }] }),
    event({ type: 'turn_aborted', reason: 'interrupted', event_id: 'interruption' }),
    event({ type: 'context_compacted', id: 'compaction' }),
  ]);
  for (const messages of [live, saved]) {
    assert.deepEqual(messages.map(message => message.id), ['first-answer', 'second-answer', 'thought', 'interruption', 'compaction']);
  }
});

test('repeated idless messages sharing a timestamp match their respective history rows after a turn switch', async () => {
  const thought = response({ type: 'reasoning', summary: [{ text: 'Review' }] });
  const compacted = event({ type: 'context_compacted' });
  const { live, saved } = await readLiveAndSaved([
    assistant('Continue'), assistant('Continue'), thought, thought, compacted, compacted,
  ], [assistant('Earlier conversation')]);
  assert.equal(new Set(saved.map(message => message.id)).size, 7);
  assert.deepEqual(live.map(message => message.id), saved.slice(1).map(message => message.id));
});

test('synthesized tool calls keep their identities between the live turn and saved history', async () => {
  const search = response({ type: 'web_search_call', action: { query: 'repeated query' } });
  const plan = assistant('<proposed_plan>Ship</proposed_plan>');
  const command = response({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}' });
  const { live, saved } = await readLiveAndSaved([
    search, search, plan, plan, command, command,
    response({ type: 'agent_message', author: '/root/reviewer', content: 'Message Type: FINAL_ANSWER\nSender: /root/reviewer\nPayload:\nFinished.' }),
  ], [assistant('Earlier conversation')]);
  const uses = live.filter(message => message.kind === 'tool_use');
  assert.deepEqual(uses.map(message => message.toolName), ['WebSearch', 'WebSearch', 'ExitPlanMode', 'ExitPlanMode', 'Bash', 'Bash', 'Task']);
  assert.equal(new Set(uses.map(message => message.toolId)).size, 7);
  assert.deepEqual(live.filter(message => message.kind === 'tool_result').map(message => message.toolId),
    [uses[2].toolId, uses[3].toolId, uses[6].toolId]);
  const identities = (messages: typeof live) => messages.map(message => [message.id, message.toolId]);
  assert.deepEqual(identities(live), identities(saved.slice(1)));
  assert.equal(new Set(live.map(message => message.id)).size, live.length);
});

test('a tool update keeps the original message ID while its result and another call get distinct IDs', async () => {
  const command = (callId: string, cmd: string) => response({
    type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd }),
  });
  const output = (callId: string) => response({ type: 'function_call_output', call_id: callId, output: 'done' });
  const { live, saved } = await readLiveAndSaved([
    command('call-one', 'pwd'), command('call-one', 'pwd -P'), output('call-one'),
    command('call-two', 'pwd -P'), output('call-two'),
  ]);
  assert.deepEqual(live.map(message => [message.kind, message.toolId]), [
    ['tool_use', 'call-one'], ['tool_use', 'call-one'], ['tool_result', 'call-one'],
    ['tool_use', 'call-two'], ['tool_result', 'call-two'],
  ]);
  assert.equal(live[0].id, live[1].id);
  assert.equal(new Set(live.map(message => message.id)).size, 4);
  assert.deepEqual(live.map(message => message.id), saved.map(message => message.id));
});

test('tool results without a call ID retain their item identity across reads', async () => {
  const { live, saved } = await readLiveAndSaved([
    response({ type: 'function_call_output', id: 'first', output: 'done' }),
    response({ type: 'function_call_output', id: 'second', output: 'done' }),
  ]);
  assert.deepEqual(live.map(message => message.toolId), ['first', 'second']);
  assert.notEqual(live[0].id, live[1].id);
  assert.deepEqual(live.map(message => message.id), saved.map(message => message.id));
});

test('tool IDs inside a batched exec are independent of how much earlier history was read', async () => {
  const { live, saved } = await readLiveAndSaved([response({
    type: 'custom_tool_call', name: 'exec', call_id: 'batch',
    input: 'await tools.web__run({search_query: [{q: "one"}]}); await tools.web__run({search_query: [{q: "two"}]});',
  })], [assistant('Earlier conversation')]);
  assert.equal(live.length, 2);
  assert.notEqual(live[0].toolId, live[1].toolId);
  assert.deepEqual(live.map(message => message.toolId), saved.slice(1).map(message => message.toolId));
});

test('reloading a subagent transcript preserves distinct IDs for its repeated idless commands', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-ids-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = response({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}' });
  await writeFile(path.join(directory, 'rollout-child.jsonl'), [command, command].map(row => JSON.stringify(row)).join('\n'));
  const parent = [
    response({ type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: '{"task_name":"reviewer"}' }),
    event({ type: 'sub_agent_activity', kind: 'started', event_id: 'spawn', agent_thread_id: 'child' }),
  ];
  async function readToolIds() {
    const history = await readCodexRollout(entries(parent), path.join(directory, 'parent.jsonl'));
    const [task] = new CodexSessionsProvider().normalizeMessage(history.messages[0], 'session');
    return task.subagentTools?.map(tool => tool.toolId);
  }
  const ids = await readToolIds();
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(await readToolIds(), ids);
});
