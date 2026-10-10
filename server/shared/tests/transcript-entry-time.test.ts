import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readLastTranscriptEntryTime } from '@/shared/utils.js';

async function withTranscript(lines: string[], run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ah-transcript-'));
  const filePath = path.join(directory, 'session.jsonl');
  await writeFile(filePath, `${lines.join('\n')}\n`);
  try {
    await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const metadataBlock = [
  '{"type":"last-prompt","lastPrompt":"hi","sessionId":"s1"}',
  '{"type":"ai-title","aiTitle":"Greeting","sessionId":"s1"}',
  '{"type":"mode","mode":"normal","sessionId":"s1"}',
  '{"type":"permission-mode","permissionMode":"auto","sessionId":"s1"}',
];

test('the hourly metadata block Claude appends does not count as activity', async () => {
  await withTranscript([
    '{"type":"user","timestamp":"2026-10-09T23:56:37.153Z","message":{"role":"user","content":"hi"}}',
    '{"type":"system","subtype":"turn_duration","timestamp":"2026-10-09T23:56:47.857Z"}',
    ...metadataBlock,
  ], async (filePath) => {
    assert.equal((await readLastTranscriptEntryTime(filePath))?.toISOString(), '2026-10-09T23:56:47.857Z');
  });
});

test('an entry longer than the first tail chunk is still found', async () => {
  const hugeToolResult = JSON.stringify({ type: 'user', timestamp: '2026-10-10T01:00:00.000Z', content: 'x'.repeat(100_000) });
  await withTranscript([hugeToolResult, ...metadataBlock], async (filePath) => {
    assert.equal((await readLastTranscriptEntryTime(filePath))?.toISOString(), '2026-10-10T01:00:00.000Z');
  });
});

test('a transcript with no timed entry, or no file, has no entry time', async () => {
  await withTranscript(metadataBlock, async (filePath) => {
    assert.equal(await readLastTranscriptEntryTime(filePath), null);
    assert.equal(await readLastTranscriptEntryTime(`${filePath}.missing`), null);
  });
});
