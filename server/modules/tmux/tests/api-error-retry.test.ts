import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_ERROR_RETRY_MARKER,
  formatApiErrorRetry,
  planApiErrorRetry,
  type ApiErrorRetryPlan,
} from '@/modules/tmux/api-error-retry.service.js';

const MINUTE = 60_000;
const ERROR_AT = Date.parse('2026-11-03T17:07:50.870Z');
const settings = { attempts: 3, delayMinutes: 1 };

let uuidCounter = 0;
const stamp = (offsetMs = 0) => ({ uuid: `row-${uuidCounter += 1}`, timestamp: new Date(ERROR_AT + offsetMs).toISOString(), isSidechain: false });

const humanPrompt = (text: string) => ({ type: 'user', ...stamp(-60 * MINUTE), message: { role: 'user', content: text } });
const toolUse = () => ({ type: 'assistant', ...stamp(-MINUTE), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } });
const toolResult = () => ({ type: 'user', ...stamp(-MINUTE), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
const assistantText = (text: string, offsetMs = -MINUTE) => ({ type: 'assistant', ...stamp(offsetMs), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const retryPrompt = (attempt: number) => ({ type: 'user', ...stamp(-MINUTE), message: { role: 'user', content: `${API_ERROR_RETRY_MARKER} ${attempt}/3: your last response ended with "x".` } });

const connectionLost = (offsetMs = 0) => ({
  type: 'assistant',
  ...stamp(offsetMs),
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: Connection lost mid-response. The response above may be incomplete.' }] },
  apiError: 'connection_failed',
  error: 'server_error',
  truncatedAfterOutput: true,
  isApiErrorMessage: true,
});
const cannotReachServer = () => ({
  type: 'assistant',
  ...stamp(),
  message: { role: 'assistant', content: [{ type: 'text', text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" }] },
  error: 'server_error',
  isApiErrorMessage: true,
});
const sessionLimit = () => ({
  type: 'assistant',
  ...stamp(),
  message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 7:50pm (Europe/Moscow)" }] },
  error: 'rate_limit',
  isApiErrorMessage: true,
});
const turnDuration = () => ({ type: 'system', subtype: 'turn_duration', durationMs: 1000, ...stamp() });
const metadata = () => ({ type: 'ai-title', aiTitle: 'Sample', sessionId: 'sample' });

const transcript = (...rows: object[]) => `{"partial line cut by the tail read\n${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const plan = (tail: string, now = ERROR_AT + 30 * MINUTE, chosen = settings): ApiErrorRetryPlan => planApiErrorRetry(tail, chosen, now);

test('a turn that lost its connection mid-response is retried one delay after the error', () => {
  const error = connectionLost();
  const result = plan(transcript(humanPrompt('do it'), toolUse(), toolResult(), assistantText('partial'), error, turnDuration(), metadata()));
  assert.equal(result.kind, 'retry');
  assert.equal(result.kind === 'retry' && result.attempt, 1);
  assert.equal(result.kind === 'retry' && result.dueAt, ERROR_AT + MINUTE);
  assert.equal(result.kind === 'retry' && result.errorUuid, error.uuid);
  assert.equal(result.kind === 'retry' && result.errorText, 'API Error: Connection lost mid-response. The response above may be incomplete.');
});

test('an unreachable API server counts as transient too', () => {
  assert.equal(plan(transcript(humanPrompt('do it'), cannotReachServer())).kind, 'retry');
});

test('limits, auth and other errors are left alone: Claude resumes usage limits itself', () => {
  assert.equal(plan(transcript(humanPrompt('do it'), sessionLimit())).kind, 'none');
  const outOfMemory = { ...connectionLost(), error: 'unknown', apiError: undefined, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Out of memory' }] } };
  assert.equal(plan(transcript(humanPrompt('do it'), outOfMemory)).kind, 'none');
  const loginExpired = { ...cannotReachServer(), error: 'authentication_failed' };
  assert.equal(plan(transcript(humanPrompt('do it'), loginExpired)).kind, 'none');
});

test('nothing to do once the user wrote after the error or the turn ended normally', () => {
  assert.equal(plan(transcript(humanPrompt('do it'), connectionLost(), humanPrompt('продолжай'))).kind, 'none');
  assert.equal(plan(transcript(humanPrompt('do it'), connectionLost(), retryPrompt(1))).kind, 'none');
  assert.equal(plan(transcript(humanPrompt('do it'), assistantText('done'))).kind, 'none');
  assert.equal(plan('').kind, 'none');
});

test('each retry in a row waits three times longer, and after the limit the plan is to stop', () => {
  const second = plan(transcript(humanPrompt('do it'), connectionLost(-10 * MINUTE), retryPrompt(1), connectionLost()));
  assert.equal(second.kind === 'retry' && second.attempt, 2);
  assert.equal(second.kind === 'retry' && second.dueAt, ERROR_AT + 3 * MINUTE);

  const third = plan(transcript(humanPrompt('do it'), connectionLost(), retryPrompt(1), connectionLost(), retryPrompt(2), connectionLost()));
  assert.equal(third.kind === 'retry' && third.dueAt, ERROR_AT + 9 * MINUTE);

  const exhausted = plan(transcript(
    humanPrompt('do it'), connectionLost(), retryPrompt(1), connectionLost(), retryPrompt(2), connectionLost(), retryPrompt(3), connectionLost(),
  ));
  assert.deepEqual(exhausted, { kind: 'exhausted', attempts: 3, errorText: 'API Error: Connection lost mid-response. The response above may be incomplete.' });
});

test('a retry that got the agent working again resets the count', () => {
  const result = plan(transcript(
    humanPrompt('do it'), connectionLost(), retryPrompt(1), connectionLost(), retryPrompt(2), toolUse(), toolResult(), connectionLost(),
  ));
  assert.equal(result.kind === 'retry' && result.attempt, 1);
});

test('a fresh prompt from the user starts a new count', () => {
  const result = plan(transcript(
    humanPrompt('do it'), connectionLost(), retryPrompt(1), connectionLost(), humanPrompt('try again'), connectionLost(),
  ));
  assert.equal(result.kind === 'retry' && result.attempt, 1);
});

test('an error older than six hours or attempts of 0 is never retried', () => {
  const tail = transcript(humanPrompt('do it'), connectionLost());
  assert.equal(plan(tail, ERROR_AT + 7 * 60 * MINUTE).kind, 'none');
  assert.equal(plan(tail, ERROR_AT, { attempts: 0, delayMinutes: 1 }).kind, 'none');
});

test('a subagent error inside the main transcript does not count', () => {
  const sidechainError = { ...connectionLost(), isSidechain: true };
  assert.equal(plan(transcript(humanPrompt('do it'), assistantText('done'), sidechainError)).kind, 'none');
});

test('the retry prompt names the attempt and the error and starts with the marker the count looks for', () => {
  const text = formatApiErrorRetry({ kind: 'retry', attempt: 2, dueAt: 0, errorUuid: 'x', errorText: 'API Error: Connection lost' }, 3);
  assert.ok(text.startsWith(`${API_ERROR_RETRY_MARKER} 2/3: `));
  assert.match(text, /"API Error: Connection lost"/);
  assert.doesNotMatch(text, /\n/);
});
