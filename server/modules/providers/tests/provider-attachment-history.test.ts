import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { appendFilesInputTag } from '@/shared/image-attachments.js';

const SESSION_ID = 'session-1';

// ---------------------------------------------------------------- Claude

test('claude history: base64 image blocks surface as user message images', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u1',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'What is in this screenshot?');
  assert.deepEqual(messages[0].images, [
    { data: 'data:image/png;base64,QUJD' },
    { data: 'data:image/jpeg;base64,REVG' },
  ]);
});

test('claude history: image-only user turns still produce a bubble', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u2',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '');
  assert.deepEqual(messages[0].images, [{ data: 'data:image/png;base64,QUJD' }]);
});

test('claude history: the TUI\'s [Image #N] markers give way to the images themselves', () => {
  const provider = new ClaudeSessionsProvider();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } };
  const withText = provider.normalizeMessage({
    uuid: 'u3',
    timestamp: '2026-10-10T00:26:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '[Image #1] [Image #2] What is this?' }, image, image] },
  }, SESSION_ID);
  assert.equal(withText.length, 1);
  assert.equal(withText[0].content, 'What is this?');
  assert.deepEqual(withText[0].images, [{ data: 'data:image/png;base64,QUJD' }, { data: 'data:image/png;base64,QUJD' }]);

  const imageOnly = provider.normalizeMessage({
    uuid: 'u4',
    timestamp: '2026-10-10T00:26:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '[Image #1]' }, image] },
  }, SESSION_ID);
  assert.equal(imageOnly.length, 1);
  assert.equal(imageOnly[0].content, '');
  assert.deepEqual(imageOnly[0].images, [{ data: 'data:image/png;base64,QUJD' }]);

  const typedLiterally = provider.normalizeMessage({
    uuid: 'u5',
    timestamp: '2026-10-10T00:26:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'What does [Image #1] mean?' }] },
  }, SESSION_ID);
  assert.equal(typedLiterally[0].content, 'What does [Image #1] mean?');
});

test('claude history: plain text user turns carry no images field', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u3',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].images, undefined);
});

test('claude history: file reference blocks restore non-image attachments', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    uuid: 'u4',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: appendFilesInputTag('Summarize this', [
          { path: 'C:/Users/x/.agentharbor/assets/brief.pdf', name: 'brief.pdf' },
        ]),
      }],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages[0].content, 'Summarize this');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.agentharbor/assets/brief.pdf', name: 'brief.pdf' },
  ]);
});
