import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findFilesRecursivelyCreatedAfter, wasCreatedAfter } from '@/shared/utils.js';

test('a file counts as new by its creation time when the filesystem reports one', () => {
  const since = new Date('2026-10-01T00:00:00Z');
  const createdBefore = Date.parse('2026-09-01T00:00:00Z');
  const modifiedAfter = Date.parse('2026-10-02T00:00:00Z');

  assert.equal(wasCreatedAfter({ birthtimeMs: createdBefore, mtimeMs: modifiedAfter }, since), false);
  assert.equal(wasCreatedAfter({ birthtimeMs: modifiedAfter, mtimeMs: modifiedAfter }, since), true);
});

test('a file on a mount without creation times (9p) counts as new once modified after the scan', () => {
  const since = new Date('2026-10-01T00:00:00Z');

  assert.equal(wasCreatedAfter({ birthtimeMs: 0, mtimeMs: Date.parse('2026-10-02T00:00:00Z') }, since), true);
  assert.equal(wasCreatedAfter({ birthtimeMs: 0, mtimeMs: Date.parse('2026-09-30T00:00:00Z') }, since), false);
});

test('the transcript scan does not descend into skipped directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ah-find-files-'));
  try {
    const sessionDirectory = path.join(root, 'SampleProject');
    await mkdir(path.join(sessionDirectory, 'session-1', 'subagents'), { recursive: true });
    await writeFile(path.join(sessionDirectory, 'session-1.jsonl'), '{}\n');
    await writeFile(path.join(sessionDirectory, 'session-1', 'subagents', 'agent-1.jsonl'), '{}\n');
    await writeFile(path.join(sessionDirectory, 'notes.txt'), 'x');

    const files = await findFilesRecursivelyCreatedAfter(root, '.jsonl', null, {
      skipDirectoryNames: new Set(['subagents']),
    });

    assert.deepEqual(files, [path.join(sessionDirectory, 'session-1.jsonl')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the transcript scan returns nothing for a missing provider folder', async () => {
  assert.deepEqual(await findFilesRecursivelyCreatedAfter(path.join(os.tmpdir(), 'ah-no-such-dir-x9'), '.jsonl', null), []);
});
