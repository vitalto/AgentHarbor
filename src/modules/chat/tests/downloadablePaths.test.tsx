import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import { asDownloadablePath, findDownloadablePathsInProse } from '@/modules/chat/utils/downloadablePaths';

const downloadFile = vi.fn(async () => undefined);
const openFileInEditor = vi.fn();

vi.mock('@/shared/downloadFile', () => ({ downloadFile }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory: vi.fn() }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

test('a whole code span or link names a file when it is absolute and has an extension', () => {
  assert.equal(asDownloadablePath('D:\\Develop\\My Proj\\отчёт.pdf'), 'D:\\Develop\\My Proj\\отчёт.pdf');
  assert.equal(asDownloadablePath('C:/Users/vital/.agentharbor/out.zip:12'), 'C:/Users/vital/.agentharbor/out.zip');
  assert.equal(asDownloadablePath('/mnt/d/out/build.tar.gz'), '/mnt/d/out/build.tar.gz');
  assert.equal(asDownloadablePath('D:\\Develop\\AgentHarbor'), null);
  assert.equal(asDownloadablePath('src/foo.ts'), null);
  assert.equal(asDownloadablePath('/api/data.json'), null);
});

test('paths in prose stop at whitespace, brackets and sentence punctuation', () => {
  const paths = (text: string) => findDownloadablePathsInProse(text).map((match) => match.path);
  assert.deepEqual(paths('Saved to D:\\out\\report.pdf. Also (C:/tmp/a.png), /tmp/log.txt:40'), [
    'D:\\out\\report.pdf',
    'C:/tmp/a.png',
    '/tmp/log.txt',
  ]);
  assert.deepEqual(paths('see https://host/home/x.txt and file:///C:/x.txt'), []);
});

test('every way an agent writes a file path gets exactly one download button', () => {
  render(
    <Markdown>
      {'Plain D:\\out\\a.pdf, code `D:\\out\\b c.pdf`, link [report](D:\\out\\c.pdf), code link [`D:\\out\\d.pdf`](D:\\out\\d.pdf), and `src/e.ts`.'}
    </Markdown>,
  );

  // Without an i18n instance in tests the label is the raw template, so match on the prefix.
  for (const button of screen.getAllByRole('button', { name: /^Download / })) {
    fireEvent.click(button);
  }
  assert.deepEqual(downloadFile.mock.calls, [
    ['D:\\out\\a.pdf'],
    ['D:\\out\\b c.pdf'],
    ['D:\\out\\c.pdf'],
    ['D:\\out\\d.pdf'],
  ]);
});

test('a markdown link to a drive path opens that path, not its percent-encoded form', () => {
  render(<Markdown>{'[the report](D:\\out\\report.pdf)'}</Markdown>);
  fireEvent.click(screen.getByText('the report'));
  assert.deepEqual(openFileInEditor.mock.calls.at(-1), ['D:\\out\\report.pdf', null]);
});
