import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listBackgroundCommands, listRunningBackgroundCommands, settleBackgroundCommands } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord } from '@/shared/types.js';

const OUTPUT_FILE = 'C:\\Users\\vital\\AppData\\Local\\Temp\\claude\\D--x\\s1\\tasks\\bjob1.output';

function launch(toolUseId: string, taskId: string, timestamp: string, input: AnyRecord): AnyRecord[] {
  return [
    {
      type: 'assistant',
      timestamp,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { run_in_background: true, ...input } }] },
    },
    {
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Command running in background with ID: ${taskId}. Output is being written to: ${OUTPUT_FILE}. You will be notified when it completes.`,
        }],
      },
      toolUseResult: { stdout: '', stderr: '', backgroundTaskId: taskId },
    },
  ];
}

function notification(toolUseId: string, taskId: string, status: string): AnyRecord {
  return {
    type: 'user',
    uuid: `n-${taskId}`,
    timestamp: '2026-10-10T20:30:00.000Z',
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
    },
  };
}

const liveSince = Date.parse('2026-10-10T20:00:00.000Z');

test('a backgrounded command with no word on its end runs while the process that launched it is up', () => {
  const commands = settleBackgroundCommands(
    launch('toolu_1', 'bjob1', '2026-10-10T20:10:00.000Z', { command: 'npm run dev', description: 'Start the dev server' }),
    liveSince,
  );

  assert.deepEqual(commands.get('toolu_1'), {
    taskId: 'bjob1',
    status: 'running',
    command: 'npm run dev',
    description: 'Start the dev server',
    outputFile: OUTPUT_FILE,
    startedAt: Date.parse('2026-10-10T20:10:00.000Z'),
  });
});

test('a command launched by an earlier process, or with none up, is stopped: nothing can still run it', () => {
  const rows = launch('toolu_1', 'bjob1', '2026-10-10T19:00:00.000Z', { command: 'sleep 600' });

  assert.equal(settleBackgroundCommands(rows, liveSince).get('toolu_1')?.status, 'stopped');
  assert.equal(settleBackgroundCommands(rows, null).get('toolu_1')?.status, 'stopped');
});

test('the task notification settles a command, a kill reads as stopped', () => {
  const rows = [
    ...launch('toolu_1', 'bjob1', '2026-10-10T20:10:00.000Z', { command: 'npm test' }),
    ...launch('toolu_2', 'bjob2', '2026-10-10T20:11:00.000Z', { command: 'npm run build' }),
    ...launch('toolu_3', 'bjob3', '2026-10-10T20:12:00.000Z', { command: 'tail -f log' }),
    notification('toolu_1', 'bjob1', 'completed'),
    notification('toolu_2', 'bjob2', 'failed'),
    notification('toolu_3', 'bjob3', 'killed'),
  ];

  const commands = settleBackgroundCommands(rows, liveSince);
  assert.deepEqual(
    ['toolu_1', 'toolu_2', 'toolu_3'].map((toolUseId) => commands.get(toolUseId)?.status),
    ['completed', 'failed', 'stopped'],
  );
});

test('a command the agent stopped with TaskStop is stopped even before any notification', () => {
  const rows = [
    ...launch('toolu_1', 'bjob1', '2026-10-10T20:10:00.000Z', { command: 'npm run dev' }),
    {
      type: 'user',
      timestamp: '2026-10-10T20:20:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: '{}' }] },
      toolUseResult: { message: 'Successfully stopped task: bjob1 (npm run dev)', task_id: 'bjob1', task_type: 'local_bash' },
    },
  ];

  assert.equal(settleBackgroundCommands(rows, liveSince).get('toolu_1')?.status, 'stopped');
});

test('a transcript lists its finished commands too, the running-sessions poll only the running ones', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ah-bg-commands-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, 's1.jsonl');
  const rows = [
    ...launch('toolu_1', 'bjob1', '2026-10-10T20:10:00.000Z', { command: 'npm test' }),
    ...launch('toolu_2', 'bjob2', '2026-10-10T20:11:00.000Z', { command: 'npm run dev' }),
    notification('toolu_1', 'bjob1', 'completed'),
  ].map((row) => ({ ...row, sessionId: 's1' }));
  await writeFile(transcript, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const all = await listBackgroundCommands(transcript, 's1', liveSince);
  assert.deepEqual(all.map((command) => [command.taskId, command.status, command.toolUseId]), [
    ['bjob1', 'completed', 'toolu_1'],
    ['bjob2', 'running', 'toolu_2'],
  ]);
  assert.deepEqual((await listRunningBackgroundCommands(transcript, 's1', liveSince)).map((command) => command.taskId), ['bjob2']);
});

test('a foreground command moved to the background by its timeout keeps its command and description', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ah-bg-commands-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, 's1.jsonl');
  const [call, result] = launch('toolu_1', 'bjob1', '2026-10-10T20:10:00.000Z', {
    command: 'unity -projectPath x',
    description: 'Open Unity editor',
    timeout: 120000,
    run_in_background: undefined,
  });
  const rows = [call, { ...result, toolUseResult: { ...result.toolUseResult, timedOutAfterMs: 120000 } }]
    .map((row) => ({ ...row, sessionId: 's1' }));
  await writeFile(transcript, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const [command] = await listBackgroundCommands(transcript, 's1', liveSince);
  assert.equal(command?.command, 'unity -projectPath x');
  assert.equal(command?.description, 'Open Unity editor');
});
