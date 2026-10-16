import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-api-request-1';

/**
 * Claude Code 2.1.302 records each API request it sends next to the
 * conversation: an `api-request` row, an `api-request-shape` row, and one
 * `api-request-blob` row per new request message. A blob carries a copy of the
 * prompt as `message: { role: 'user', content }` with no uuid and no
 * timestamp, so it read as a second user turn stamped with the time of the
 * read, which put the user's message again after Claude's reply.
 */
test('an API request blob is not a message', () => {
  const rows = provider.normalizeMessage({
    type: 'api-request-blob',
    sessionId: SESSION_ID,
    hash: 'c9d7d6a3',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\ninstructions\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>' },
        { type: 'text', text: '<system-reminder>\nattribution\n</system-reminder>' },
        { type: 'text', text: 'Pick a color for me' },
      ],
    },
  }, SESSION_ID);

  assert.deepEqual(rows, []);
});

test('API request records that carry no message stay empty too', () => {
  for (const type of ['api-request', 'api-request-shape']) {
    assert.deepEqual(provider.normalizeMessage({
      type,
      sessionId: SESSION_ID,
      timestamp: '2026-10-16T20:55:05.275Z',
    }, SESSION_ID), []);
  }
});

test('the prompt row itself still becomes the user message', () => {
  const rows = provider.normalizeMessage({
    type: 'user',
    uuid: 'e99dc49a',
    sessionId: SESSION_ID,
    timestamp: '2026-10-16T20:55:05.113Z',
    message: { role: 'user', content: 'Pick a color for me' },
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].content, 'Pick a color for me');
});

test('a loaded history shows the prompt once and keeps the question answered', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-api-request-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const transcriptPath = path.join(tempRoot, `${SESSION_ID}.jsonl`);
  const question = { question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] };
  const acknowledgement = 'Your questions have been answered: "Pick a color"="Red".';
  const rows = [
    { type: 'user', uuid: 'u-prompt', parentUuid: null, sessionId: SESSION_ID, timestamp: '2026-10-16T20:55:05.113Z', message: { role: 'user', content: 'Pick a color for me' } },
    { type: 'api-request-blob', sessionId: SESSION_ID, hash: 'h1', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>' }, { type: 'text', text: 'Pick a color for me' }] } },
    { type: 'api-request', sessionId: SESSION_ID, timestamp: '2026-10-16T20:55:05.275Z', tail: ['h1'] },
    { type: 'assistant', uuid: 'a-ask', parentUuid: 'u-prompt', sessionId: SESSION_ID, timestamp: '2026-10-16T20:55:08.436Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [question] } }] } },
    { type: 'user', uuid: 'u-answer', parentUuid: 'a-ask', sessionId: SESSION_ID, timestamp: '2026-10-16T20:55:09.126Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: acknowledgement }] }, toolUseResult: { questions: [question], answers: { 'Pick a color': 'Red' } } },
    // The next request repeats the answer without the structured result.
    { type: 'api-request-blob', sessionId: SESSION_ID, hash: 'h2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'tampered' }] } },
    { type: 'assistant', uuid: 'a-reply', parentUuid: 'u-answer', sessionId: SESSION_ID, timestamp: '2026-10-16T20:55:34.440Z', message: { role: 'assistant', content: [{ type: 'text', text: 'You picked red.' }] } },
  ];
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Question session', now, now, transcriptPath);

    const history = await provider.fetchHistory(SESSION_ID, { providerSessionId: SESSION_ID });

    const prompts = history.messages.filter((message) => message.kind === 'text' && message.role === 'user');
    assert.deepEqual(prompts.map((message) => message.id), ['u-prompt']);

    const ask = history.messages.find((message) => message.toolName === 'AskUserQuestion');
    assert.ok(ask, 'the question card is in the history');
    assert.deepEqual((ask.toolInput as { answers?: unknown }).answers, { 'Pick a color': 'Red' });
    assert.equal(ask.toolResult?.content, acknowledgement);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
