import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCodexRollout } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord } from '@/shared/index.js';

const script = 'const f = load("path"); await tools.apply_patch(`*** Begin Patch\\n*** Add File: ${f}\\n+${load("body")}\\n*** End Patch`)';
const start = Date.parse('2026-11-18T10:00:00Z');
const call = { timestamp: new Date(start).toISOString(), type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', call_id: 'outer', input: script } };
const output = { timestamp: new Date(start + 500).toISOString(), type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: 'outer', output: 'wrapper result' } };

function fileChange(id: string, changes: AnyRecord, status = 'completed') {
  return { timestamp: new Date(start + 250).toISOString(), type: 'event_msg', payload: {
    type: 'item_completed', turn_id: 'turn', started_at_ms: start + 50,
    item: { type: 'FileChange', id, changes, status, stdout: 'file report', stderr: status === 'failed' ? 'patch rejected' : '' },
  } };
}

async function* entries(rows: AnyRecord[]) {
  yield* rows;
}

test('a wrapped patch publishes the recorded filename and complete Write content as soon as FileChange arrives', async () => {
  const live: AnyRecord[] = [];
  const report = fileChange('exec-native', { '/repo/real.ts': { type: 'add', content: 'first\nsecond\n' } });

  async function* rollout() {
    yield call;
    yield report;
    assert.equal(live.length, 2, 'live chat should already have the file and its result');
    yield report;
    yield output;
  }

  const { messages } = await readCodexRollout(rollout(), undefined, row => live.push({ ...row }));
  for (const rows of [live, messages]) {
    assert.deepEqual(rows.map(row => [row.type, row.toolCallId]), [['tool_use', 'outer'], ['tool_result', 'outer']]);
    assert.equal(rows[0].toolName, 'Write');
    const input = JSON.parse(rows[0].toolInput);
    assert.equal(input.file_path, '/repo/real.ts');
    assert.equal(input.content, 'first\nsecond\n');
    assert.equal(rows[1].output, 'file report');
    assert.equal(rows[1].isError, false);
  }
});

test('separate patch invocations inside one wrapper retain their diffs and individual outcomes', async () => {
  const rows = [
    call,
    fileChange('exec-update', { '/repo/used.ts': { type: 'update', unified_diff: '@@ -1,2 +1,2 @@\n before\n-old\n+new\n' } }),
    fileChange('exec-delete', { '/repo/used.ts': { type: 'delete', content: 'before\nnew\n' } }, 'failed'),
    output,
  ];
  const { messages } = await readCodexRollout(entries(rows));
  const calls = messages.filter(row => row.type === 'tool_use');
  const results = messages.filter(row => row.type === 'tool_result');
  assert.deepEqual(calls.map(row => [row.toolName, JSON.parse(row.toolInput)]), [
    ['Edit', { file_path: '/repo/used.ts', old_string: 'before\nold', new_string: 'before\nnew' }],
    ['Edit', { file_path: '/repo/used.ts', old_string: 'before\nnew\n', new_string: '', deleted: true }],
  ]);
  assert.equal(new Set(calls.map(row => row.toolCallId)).size, 2);
  assert.deepEqual(results.map(row => [row.toolCallId, row.output, row.isError]), [
    [calls[0].toolCallId, 'file report', false], [calls[1].toolCallId, 'patch rejected', true],
  ]);
});

test('a failed computed patch with no reported paths keeps the error attached to its wrapper', async () => {
  const { messages } = await readCodexRollout(entries([call, fileChange('exec-failed', {}, 'failed'), output]));
  assert.deepEqual(messages.map(row => [row.type, row.toolCallId]), [['tool_use', 'outer'], ['tool_result', 'outer']]);
  assert.equal(messages[0].toolName, 'exec');
  assert.equal(messages[0].toolInput, script);
  assert.equal(messages[1].isError, true);
  assert.equal(messages[1].output, 'patch rejected');
});

test('reading a rollout before a patch completes keeps the call pending', async () => {
  const running = { ...output, payload: { ...output.payload, output: 'Script running with cell ID cell-one' } };
  for (const rows of [[call], [call, running]]) {
    const { messages } = await readCodexRollout(entries(rows));
    assert.deepEqual(messages.map(row => [row.type, row.toolCallId]), [['tool_use', 'outer']]);
    assert.equal(messages[0].toolInput, script);
  }
});

test('old rollouts without file reports retain static patch inputs and the source of a computed patch', async () => {
  const staticPatch = '*** Begin Patch\n*** Add File: /repo/old.txt\n+older\n*** End Patch';
  const staticScript = `const patch = ${JSON.stringify(staticPatch)}; await tools.apply_patch(patch)`;
  const { messages } = await readCodexRollout(entries([
    { ...call, payload: { ...call.payload, call_id: 'old', input: staticScript } },
    { ...output, payload: { ...output.payload, call_id: 'old' } },
    call, output,
  ]));
  const calls = messages.filter(row => row.type === 'tool_use');
  assert.deepEqual(calls.map(row => row.toolName), ['Write', 'exec']);
  assert.equal(JSON.parse(calls[0].toolInput).content, 'older');
  assert.equal(calls[1].toolInput, script);
  assert.deepEqual(messages.filter(row => row.type === 'tool_result').map(row => row.toolCallId), ['old', 'outer']);
});

test('paginated FileChange reports can render multiple files without a wrapper', async () => {
  const report = fileChange('standalone', {
    '/repo/empty': { type: 'add', content: '' },
    '/repo/gone': { type: 'delete', content: 'deleted contents' },
  });
  const { messages } = await readCodexRollout(entries([report, report]));
  const uses = messages.filter(row => row.type === 'tool_use');
  assert.deepEqual(uses.map(row => [row.toolName, row.toolCallId, JSON.parse(row.toolInput).file_path]), [
    ['Write', 'standalone#0', '/repo/empty'], ['Edit', 'standalone#1', '/repo/gone'],
  ]);
  assert.equal(JSON.parse(uses[0].toolInput).content, '');
  assert.equal(JSON.parse(uses[1].toolInput).old_string, 'deleted contents');
  assert.equal(messages.filter(row => row.type === 'tool_result').length, 2);
});

test('a shell command mentioning apply_patch produces only the shell tool and its result', async () => {
  const patch = '*** Begin Patch\n*** Add File: /repo/example\n+example\n*** End Patch';
  const example = `tools.apply_patch(${JSON.stringify(patch)})`;
  const command = "rg 'tools.apply_patch('";
  const input = [
    `const example = '${example}';`,
    `/* ${example} */`,
    `// ${example}`,
    `await tools.exec_command({cmd: ${JSON.stringify(command)}})`,
  ].join('\n');
  const { messages } = await readCodexRollout(entries([{ ...call, payload: { ...call.payload, input } }, output]));
  assert.deepEqual(messages.map(row => [row.type, row.toolCallId]), [['tool_use', 'outer'], ['tool_result', 'outer']]);
  assert.equal(messages[0].toolName, 'Bash');
  assert.equal(JSON.parse(messages[0].toolInput).command, command);
});

test('older patch_apply_end reports preserve added and deleted file contents', async () => {
  const report = { type: 'event_msg', payload: {
    type: 'patch_apply_end', call_id: 'legacy-native', success: true, changes: {
      '/repo/file.txt': { type: 'add', content: 'written\n' },
      '/repo/obsolete.txt': { type: 'delete', content: 'removed\n' },
    },
  } };
  const { messages } = await readCodexRollout(entries([call, report, output]));
  const uses = messages.filter(row => row.type === 'tool_use');
  assert.deepEqual(uses.map(row => row.toolName), ['Write', 'Edit']);
  assert.equal(JSON.parse(uses[0].toolInput).content, 'written\n');
  assert.deepEqual(JSON.parse(uses[1].toolInput), {
    file_path: '/repo/obsolete.txt', old_string: 'removed\n', new_string: '', deleted: true,
  });
  assert.deepEqual(messages.filter(row => row.type === 'tool_result').map(row => row.toolCallId), uses.map(row => row.toolCallId));
});

test('a child rollout shows the applied patch once with its actual contents and result', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-child-file-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = [
    call, fileChange('child-file', { '/repo/child.txt': { type: 'add', content: 'nested\n' } }), output,
  ];
  await writeFile(path.join(directory, 'rollout-child-thread.jsonl'), child.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const parent = [
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started', event_id: 'spawn', agent_thread_id: 'child-thread' } },
  ];
  const { messages } = await readCodexRollout(entries(parent), path.join(directory, 'rollout-parent.jsonl'));
  const activity = messages.find(row => row.toolName === 'Task')?.subagentTools;
  assert.equal(activity?.length, 1);
  assert.equal(activity[0].toolName, 'Write');
  assert.equal(activity[0].toolInput.file_path, '/repo/child.txt');
  assert.equal(activity[0].toolInput.content, 'nested\n');
  assert.deepEqual(activity[0].toolResult, { content: 'file report', isError: false });
});
