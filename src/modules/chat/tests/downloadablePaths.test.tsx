import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import { asFileReference, findFileReferencesInProse } from '@/modules/chat/utils/downloadablePaths';

const downloadFile = vi.fn(async () => undefined);
const openFileInEditor = vi.fn();
const resolveRequests: string[][] = [];
const existingFiles = new Map<string, string>();

vi.mock('@/shared/downloadFile', () => ({ downloadFile }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory: vi.fn() }),
}));
vi.mock('@/shared/api', () => ({
  api: {
    downloads: {
      resolve: async (_sessionId: string | null, paths: string[]) => {
        resolveRequests.push(paths);
        return new Response(JSON.stringify({
          resolved: Object.fromEntries(paths.map((reference) => [reference, existingFiles.get(reference) ?? null])),
        }));
      },
      content: async () => new Response('bytes'),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

test('a whole code span or link names a file when it has an extension', () => {
  assert.equal(asFileReference('D:\\Develop\\My Proj\\отчёт.pdf'), 'D:\\Develop\\My Proj\\отчёт.pdf');
  assert.equal(asFileReference('C:/Users/vital/.agentharbor/out.zip:12'), 'C:/Users/vital/.agentharbor/out.zip');
  assert.equal(asFileReference('/mnt/d/out/build.tar.gz'), '/mnt/d/out/build.tar.gz');
  assert.equal(asFileReference('docs/guides/blind-playtest.md'), 'docs/guides/blind-playtest.md');
  assert.equal(asFileReference('…\\scratchpad\\exe_icon.png'), '…\\scratchpad\\exe_icon.png');
  assert.equal(asFileReference('Floor7.exe'), 'Floor7.exe');
  assert.equal(asFileReference('D:\\Develop\\AgentHarbor'), null);
  assert.equal(asFileReference('Builds\\Release'), null);
  assert.equal(asFileReference('0.3.0'), null);
  assert.equal(asFileReference('/api/data.json'), null);
  assert.equal(asFileReference('https://host/a.json'), null);
  assert.equal(asFileReference('const a = b.c'), null);
});

test('paths in prose stop at whitespace, brackets and sentence punctuation', () => {
  const paths = (text: string) => findFileReferencesInProse(text).map((match) => match.path);
  assert.deepEqual(paths('Saved to D:\\out\\report.pdf. Also (C:/tmp/a.png), /tmp/log.txt:40'), [
    'D:\\out\\report.pdf',
    'C:/tmp/a.png',
    '/tmp/log.txt',
  ]);
  assert.deepEqual(paths('see docs/guides/план.md, …\\scratchpad\\shot.png and ./a/b.txt.'), [
    'docs/guides/план.md',
    '…\\scratchpad\\shot.png',
    './a/b.txt',
  ]);
  assert.deepEqual(paths('see https://host/home/x.txt and file:///C:/x.txt, e.g. Node.js 0.3.0'), []);
});

test('every way an agent writes an existing file gets exactly one download button', async () => {
  for (const reference of ['D:\\out\\a.pdf', 'D:\\out\\b c.pdf', 'D:\\out\\c.pdf', 'D:\\out\\d.pdf', 'docs/f.zip', '…\\scratchpad\\g.zip']) {
    existingFiles.set(reference, `/local/${reference.split(/[\\/]/).pop()}`);
  }
  render(
    <Markdown>
      {'Plain D:\\out\\a.pdf, code `D:\\out\\b c.pdf`, link [report](D:\\out\\c.pdf), code link [`D:\\out\\d.pdf`](D:\\out\\d.pdf), `src/e.ts` that does not exist, relative `docs/f.zip` and shortened `…\\scratchpad\\g.zip`.'}
    </Markdown>,
  );

  // Without an i18n instance in tests the label is the raw template, so match on the prefix.
  await waitFor(() => assert.equal(screen.getAllByRole('button', { name: /^Download / }).length, 6));
  for (const button of screen.getAllByRole('button', { name: /^Download / })) {
    fireEvent.click(button);
  }
  assert.deepEqual(downloadFile.mock.calls, [
    ['/local/a.pdf'],
    ['/local/b c.pdf'],
    ['/local/c.pdf'],
    ['/local/d.pdf'],
    ['/local/f.zip'],
    ['/local/g.zip'],
  ]);
  assert.equal(resolveRequests.length, 1, 'all paths of a render go to the server in one request');
  assert.ok(resolveRequests[0].includes('src/e.ts'));
});

test('a previewable file gets a preview button that opens a dialog', async () => {
  existingFiles.set('notes/plan.txt', '/local/plan.txt');
  render(<Markdown>{'Plan in `notes/plan.txt`.'}</Markdown>);

  fireEvent.click(await screen.findByRole('button', { name: /^Preview / }));
  assert.ok(await screen.findByRole('dialog'));
});

test('a markdown link to a drive path opens that path, not its percent-encoded form', () => {
  render(<Markdown>{'[the report](D:\\out\\report.pdf)'}</Markdown>);
  fireEvent.click(screen.getByText('the report'));
  assert.deepEqual(openFileInEditor.mock.calls.at(-1), ['D:\\out\\report.pdf', null]);
});
