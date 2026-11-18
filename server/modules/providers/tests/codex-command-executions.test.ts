import assert from 'node:assert/strict';
import test from 'node:test';

import { readCodexRollout } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord } from '@/shared/index.js';

const wrapper = 'const body = load("script"); text(await tools.exec_command({cmd: "@\'\\n" + body + "\\n\'@ | python -"}))';
const fullCommand = "@'\nprint('first line')\nprint('last line')\n'@ | python -";

function call(id: string, input = wrapper, start = 1000) {
  return { timestamp: new Date(start).toISOString(), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input } };
}

function execution(id: string, command: string[], start = 1200) {
  return { timestamp: new Date(start + 200).toISOString(), type: 'event_msg', payload: {
    type: 'item_completed', started_at_ms: start, item: {
      type: 'CommandExecution', id, command, source: 'unified_exec_startup', status: 'completed',
    },
  } };
}

function output(id: string, text = 'done') {
  return { timestamp: new Date(2000).toISOString(), type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: id, output: text } };
}

async function* entries(rows: AnyRecord[]) {
  yield* rows;
}

test('a computed PowerShell command reaches live chat and history in full under the original call ID', async () => {
  const snapshots: AnyRecord[] = [];
  const { messages } = await readCodexRollout(entries([
    call('shell'), execution('exec-native', ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', fullCommand]), output('shell'),
  ]), undefined, row => snapshots.push({ ...row }));

  const savedCalls = messages.filter(row => row.type === 'tool_use');
  assert.equal(savedCalls.length, 1);
  const saved = savedCalls[0];
  assert.equal(saved.toolName, 'Bash');
  assert.equal(saved.toolCallId, 'shell');
  assert.equal(JSON.parse(saved.toolInput).command, fullCommand);
  const liveCalls = snapshots.filter(row => row.type === 'tool_use');
  assert.deepEqual([...new Set(liveCalls.map(row => row.toolCallId))], ['shell']);
  assert.equal(liveCalls.at(-1)?.toolInput, saved.toolInput);
  assert.deepEqual(snapshots.filter(row => row.type === 'tool_result').map(row => [row.toolCallId, row.output]), [['shell', 'done']]);
});

test('a batched exec preserves repeated commands and ignores a replay of one native completion', async () => {
  const first = execution('first', ['/bin/bash', '-lc', 'echo first'], 1200);
  const second = execution('second', ['/bin/bash', '-lc', 'echo again'], 1300);
  const third = execution('third', ['/bin/bash', '-lc', 'echo again'], 1350);
  const { messages } = await readCodexRollout(entries([
    call('batch', 'await Promise.all(load("commands").map(cmd => tools.exec_command({cmd})))'),
    second, second, third, first, output('batch'),
  ]));
  const rows = messages.filter(row => row.type === 'tool_use');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolName, 'Bash');
  assert.equal(JSON.parse(rows[0].toolInput).command, 'echo first\necho again\necho again');
});

test('an unresolvable or overlapping wrapper keeps its complete source', async () => {
  const input = 'await tools.exec_command({ cmd: "echo " + load("body") })';
  const { messages } = await readCodexRollout(entries([
    call('missing', input), output('missing'), call('one', input), call('two', input),
    execution('unrelated-id', ['pwsh', '-Command', 'echo ambiguous']), output('two'), output('one'),
    call('next', input, 1600), execution('late', ['pwsh', '-Command', 'echo older'], 900), output('next'),
  ]));
  assert.deepEqual(messages.filter(row => row.type === 'tool_use').map(row => [row.toolName, row.toolInput]),
    Array.from({ length: 4 }, () => ['exec', input]));
});

test('the execution reports replace the labels and arguments inferred from a mapped batch', async () => {
  const source = 'const jobs = [["first","echo one"],["second","echo two"]]; await Promise.all(jobs.map(([,cmd]) => tools.exec_command({cmd})))';
  const { messages } = await readCodexRollout(entries([
    call('batch', source), execution('one', ['sh', '-c', 'echo one']),
    execution('two', ['sh', '-c', 'echo two'], 1250), output('batch'),
  ]));
  assert.equal(JSON.parse(messages.find(row => row.type === 'tool_use')!.toolInput).command, 'echo one\necho two');
});

test('a computed shell command keeps the output returned by a wait on its cell', async () => {
  const { messages } = await readCodexRollout(entries([
    call('shell'), output('shell', 'Script running with cell ID c1\nOutput:\n'),
    { type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'wait', arguments: '{"cell_id":"c1"}' } },
    execution('delayed', ['pwsh', '-Command', fullCommand], 2100),
    output('wait', 'Exit code: 0\nOutput:\nprinted'),
  ]));
  const tool = messages.find(row => row.type === 'tool_use')!;
  assert.equal(JSON.parse(tool.toolInput).command, fullCommand);
  assert.deepEqual(messages.filter(row => row.type === 'tool_result').map(row => [row.toolCallId, row.output]), [['shell', 'printed']]);
});

test('a computed shell command remains visible alongside a different tool in the same wrapper', async () => {
  const { messages } = await readCodexRollout(entries([
    call('mixed', wrapper + '; await tools.web__run({search_query:[{q:"hello"}]})'),
    execution('shell', ['pwsh', '-Command', fullCommand]), output('mixed'),
  ]));
  const rows = messages.filter(row => row.type === 'tool_use');
  assert.deepEqual(rows.map(row => row.toolName), ['Bash', 'WebSearch']);
  assert.equal(JSON.parse(rows[0].toolInput).command, fullCommand);
});
