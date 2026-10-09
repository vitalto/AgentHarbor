import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTranscriptTail } from '@/modules/tmux/transcript-tail.js';

async function tempTranscript(initial: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ah-tail-'));
  const filePath = path.join(directory, 's.jsonl');
  await writeFile(filePath, initial);
  return { filePath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('starts at the end of the file by default and returns only appended rows', async (t) => {
  const { filePath, cleanup } = await tempTranscript('{"n":0}\n');
  t.after(cleanup);
  const tail = createTranscriptTail(filePath);
  assert.deepEqual(await tail.poll(), { rows: [], reset: false });

  await appendFile(filePath, '{"n":1}\n{"n":2}\n');
  assert.deepEqual((await tail.poll()).rows, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual((await tail.poll()).rows, []);
});

test('holds back a half-written line until it is complete', async (t) => {
  const { filePath, cleanup } = await tempTranscript('');
  t.after(cleanup);
  const tail = createTranscriptTail(filePath, 0);

  await appendFile(filePath, '{"text":"при');
  assert.deepEqual((await tail.poll()).rows, []);
  await appendFile(filePath, 'вет"}\n{"n":');
  assert.deepEqual((await tail.poll()).rows, [{ text: 'привет' }]);
  await appendFile(filePath, '3}\n');
  assert.deepEqual((await tail.poll()).rows, [{ n: 3 }]);
});

test('skips malformed lines', async (t) => {
  const { filePath, cleanup } = await tempTranscript('');
  t.after(cleanup);
  const tail = createTranscriptTail(filePath, 0);
  await appendFile(filePath, 'not json\n{"ok":true}\n');
  assert.deepEqual((await tail.poll()).rows, [{ ok: true }]);
});

test('reports a reset when the file shrinks', async (t) => {
  const { filePath, cleanup } = await tempTranscript('{"n":1}\n{"n":2}\n');
  t.after(cleanup);
  const tail = createTranscriptTail(filePath);
  await tail.poll();
  await writeFile(filePath, '{"n":9}\n');
  assert.deepEqual(await tail.poll(), { rows: [], reset: true });
  assert.deepEqual((await tail.poll()).rows, [{ n: 9 }]);
});

test('a transcript created after tailing started is read from its first row', async (t) => {
  const { filePath, cleanup } = await tempTranscript('');
  t.after(cleanup);
  const later = `${filePath}.new`;
  const tail = createTranscriptTail(later);
  assert.deepEqual(await tail.poll(), { rows: [], reset: false });
  await writeFile(later, '{"first":true}\n');
  assert.deepEqual((await tail.poll()).rows, [{ first: true }]);
});
