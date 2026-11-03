import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  scanTranscriptLines,
  windowsPathToWslPath,
  wslPathToWindowsPath,
} from '@/modules/providers/services/transcript-line-scanner.js';

test('drive paths map between the WSL mount and Windows both ways', () => {
  assert.equal(wslPathToWindowsPath('/mnt/c/Users/alice/.claude/a b.jsonl'), 'C:\\Users\\alice\\.claude\\a b.jsonl');
  assert.equal(wslPathToWindowsPath('/home/alice/x.jsonl'), null);
  assert.equal(windowsPathToWslPath('C:\\Users\\alice\\.claude\\проект.jsonl'), '/mnt/c/Users/alice/.claude/проект.jsonl');
  assert.equal(windowsPathToWslPath('/home/alice/x.jsonl'), '/home/alice/x.jsonl');
});

test('the scan hands over only lines holding a search string, grouped by file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'transcript-scan-'));
  const previousWindowsRipgrep = process.env.AH_WINDOWS_RIPGREP;
  delete process.env.AH_WINDOWS_RIPGREP;
  try {
    const first = path.join(directory, 'first.jsonl');
    const second = path.join(directory, 'second.jsonl');
    await writeFile(first, ['{"text":"Плагин Pages"}', '{"text":"unrelated"}', `{"text":"${'x'.repeat(200_000)} pages"}`].join('\n'));
    await writeFile(second, '{"text":"nothing here"}\n');

    const linesByFile = new Map<string, string[]>();
    await scanTranscriptLines(['pages'], [first, second], (filePath, lines) => linesByFile.set(filePath, lines));

    assert.deepEqual([...linesByFile.keys()], [first]);
    assert.deepEqual(linesByFile.get(first), ['{"text":"Плагин Pages"}']);
  } finally {
    if (previousWindowsRipgrep === undefined) {
      delete process.env.AH_WINDOWS_RIPGREP;
    } else {
      process.env.AH_WINDOWS_RIPGREP = previousWindowsRipgrep;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
