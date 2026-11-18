import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  API_ERROR_RETRY_MARKER, isAwaitingApiErrorRetry, planCodexApiErrorRetry, sweepApiErrorRetries,
} from '@/modules/tmux/api-error-retry.service.js';
import { parseCodexScreen } from '@/modules/tmux/codex-tui.js';
import { paneRegistry } from '@/modules/tmux/pane-registry.service.js';
import type { AgentPane } from '@/modules/tmux/tmux.service.js';

const minute = 60_000;
const failedAt = Date.parse('2026-11-03T17:07:00.000Z');
const settings = { attempts: 3, delayMinutes: 1 };
const record = (type: string, payload: object) => JSON.stringify({ timestamp: new Date(failedAt).toISOString(), type, payload });
const event = (type: string, fields = {}) => record('event_msg', { type, ...fields });
const started = event('task_started', { turn_id: 'turn-one' });
const user = (message: string) => event('user_message', { message });
const connectionError = { message: 'stream disconnected before completion: request failed',
  codex_error_info: { response_stream_disconnected: { http_status_code: null } } };
const terminalError = event('error', connectionError);
const completion = (error: object | null) => event('task_complete', { turn_id: 'turn-one', last_agent_message: null, error });
const rollout = (...records: string[]) => records.join('\n') + '\n';
const plan = (...rows: string[]) => planCodexApiErrorRetry(rollout(started, user('continue'), ...rows), settings, failedAt);

test('Codex terminal error and failed completion describe the same failed turn', () => {
  const expected = { kind: 'retry', attempt: 1, errorUuid: 'turn-one', dueAt: failedAt + minute, errorText: 'Codex API connection failed' };
  assert.deepEqual(plan(terminalError), expected);
  assert.deepEqual(plan(terminalError, completion(connectionError), event('token_count')), expected);
  assert.deepEqual(plan(completion(connectionError)), expected);
  assert.deepEqual(plan(terminalError, event('task_complete', { turn_id: 'turn-one', last_agent_message: null })), expected);
  for (const code of ['internal_server_error', 'server_overloaded', { response_too_many_failed_attempts: { http_status_code: 503 } },
    { http_connection_failed: { http_status_code: 408 } }, { response_stream_disconnected: { http_status_code: 200 } },
    { response_stream_connection_failed: {} }, 'other']) {
    assert.equal(plan(completion({ ...connectionError, codex_error_info: code })).kind, 'retry');
  }
  assert.equal(plan(completion({ ...connectionError, message: 'failed to connect to server on port 443, request id 429-abc' })).kind, 'retry');
});

test('permanent errors, tool output, native reconnects, interrupted or superseded work do not qualify', () => {
  for (const codex_error_info of ['usage_limit_exceeded', 'rate_limit_exceeded', 'unauthorized', 'bad_request', 'cyber_policy',
    { http_connection_failed: { http_status_code: 403 } }, { response_too_many_failed_attempts: { http_status_code: 429 } }]) {
    assert.equal(plan(completion({ ...connectionError, codex_error_info })).kind, 'none');
  }
  for (const message of ['stream disconnected before completion: HTTP 401 unauthorized', 'last status: 429',
    'HTTP/2 403', 'stream disconnected before completion: invalid API key']) {
    assert.equal(plan(completion({ ...connectionError, message })).kind, 'none');
  }
  assert.equal(plan(event('stream_error', connectionError)).kind, 'none');
  assert.equal(plan(record('response_item', { type: 'function_call_output', output: JSON.stringify(connectionError) })).kind, 'none');
  assert.equal(plan(user('stream disconnected before completion')).kind, 'none');
  for (const after of [started, completion(null), event('turn_aborted', { reason: 'interrupted' }),
    event('thread_rolled_back'), user('stop'), event('agent_message'), event('task_complete', { last_agent_message: 'done' })]) {
    assert.equal(plan(terminalError, after).kind, 'none');
  }
  assert.equal(plan(terminalError, event('turn_aborted'), completion(connectionError)).kind, 'none');
});

test('the recorded retry number survives tail truncation, resets on progress and respects settings', () => {
  const retry = (n: number) => user(`${API_ERROR_RETRY_MARKER} ${n}/3: your last response ended with an error.`);
  const partial = rollout('partial JSON row', retry(2), terminalError, completion(connectionError));
  const planned = planCodexApiErrorRetry(partial, settings, failedAt);
  assert.ok(planned.kind === 'retry' && planned.attempt === 3 && planned.dueAt === failedAt + 9 * minute);
  assert.deepEqual(plan(retry(3), terminalError), { kind: 'exhausted', attempts: 3, errorText: 'Codex API connection failed' });
  for (const progress of [user('new request'), record('response_item', { type: 'function_call_output', output: 'ok' })]) {
    const result = plan(retry(3), progress, terminalError);
    assert.ok(result.kind === 'retry' && result.attempt === 1);
  }
  assert.equal(planCodexApiErrorRetry(partial, { ...settings, attempts: 0 }, failedAt).kind, 'none');
  assert.equal(planCodexApiErrorRetry(partial, settings, failedAt + 361 * minute).kind, 'none');
  assert.equal(planCodexApiErrorRetry(rollout(terminalError), settings, failedAt).kind, 'none');
});

test('Codex sweep holds pending owned sessions, rechecks the rollout at delivery, and persists one claim per failed turn', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ah-codex-retry-'));
  const original = { DATABASE_PATH: process.env.DATABASE_PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    AH_API_ERROR_RETRY_ATTEMPTS: process.env.AH_API_ERROR_RETRY_ATTEMPTS, AH_API_ERROR_RETRY_DELAY_MINUTES: process.env.AH_API_ERROR_RETRY_DELAY_MINUTES };
  closeConnection();
  const database = path.join(directory, 'auth.db');
  Object.assign(process.env, { DATABASE_PATH: database, CLAUDE_CONFIG_DIR: directory, AH_API_ERROR_RETRY_ATTEMPTS: '3', AH_API_ERROR_RETRY_DELAY_MINUTES: '1' });
  t.after(async () => {
    closeConnection();
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(database, '');
  await initializeDatabase();
  const file = path.join(directory, 'thread.jsonl');
  const failed = rollout(started, user('continue'), terminalError, completion(connectionError));
  await writeFile(file, failed);
  const pane: AgentPane = { windowId: '@1', paneId: '%1', windowName: 'codex-owned', panePid: 123,
    cwd: directory, dead: false, command: 'codex', currentCommand: 'codex' };
  const threads = [
    { providerSessionId: 'owned', activity: 'idle' as const, pane },
    { providerSessionId: 'local-draft', activity: 'unknown' as const, pane },
    { providerSessionId: 'dialog', activity: 'waiting' as const, pane },
    { providerSessionId: 'busy', activity: 'working' as const, pane },
    { providerSessionId: 'external', activity: 'idle' as const, pane: null },
  ];
  for (const thread of threads) sessionsDb.createSession(thread.providerSessionId, 'codex', directory, undefined, undefined, undefined, file);
  t.mock.method(paneRegistry, 'refresh', async () => []);
  let now = failedAt;
  let online = false;
  let changedBeforeInput = false;
  let draftBeforePaste = false;
  let uncertainAfterEnter = false;
  let deliveries = 0;
  t.mock.method(Date, 'now', () => now);
  const idleScreen = parseCodexScreen({ lines: ['› '], title: 'owned', cursorX: 2, cursorY: 0, cursorVisible: true, dead: false });
  const runtime: NonNullable<Parameters<typeof sweepApiErrorRetries>[1]> = {
    listThreads: async () => threads,
    online: async () => online,
    send: async (id, target, text, claim) => {
      assert.equal(target, pane);
      assert.equal(id, 'owned');
      assert.match(text, /API error retry 1\/3/);
      if (changedBeforeInput) await writeFile(file, failed + user('new request') + '\n');
      assert.ok(claim);
      if (!await claim(idleScreen)) return false;
      if (draftBeforePaste) return false;
      deliveries++;
      if (uncertainAfterEnter) throw new Error('Codex closed before confirming submission');
      return true;
    },
  };
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  assert.ok(isAwaitingApiErrorRetry('owned'));
  now += minute;
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  online = true;
  changedBeforeInput = true;
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  changedBeforeInput = false;
  await writeFile(file, failed);
  draftBeforePaste = true;
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  draftBeforePaste = false;
  const concurrent = await Promise.all([sweepApiErrorRetries(now, runtime), sweepApiErrorRetries(now, runtime)]);
  assert.equal(concurrent[0] + concurrent[1], 1);
  closeConnection();
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  assert.equal(isAwaitingApiErrorRetry('owned'), false);
  assert.equal(deliveries, 1);
  await writeFile(file, failed.replaceAll('turn-one', 'turn-two'));
  const recoverableLog = t.mock.method(console, 'error', () => {});
  uncertainAfterEnter = true;
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  assert.equal(recoverableLog.mock.callCount(), 1);
  uncertainAfterEnter = false;
  closeConnection();
  assert.equal(await sweepApiErrorRetries(now, runtime), 0);
  assert.equal(deliveries, 2);
});
