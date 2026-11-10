import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The Files tab shows everything: ignored folders are listed dimmed and read
 * when opened, and the location bar opens any folder on the machine, read-only.
 */

const ROOT = '/workspace/sandbox';
const OUTSIDE = '/workspace';

const projectTree = [
  { type: 'directory', name: 'node_modules', path: `${ROOT}/node_modules`, ignored: true },
  { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });

const requestedDirectories: Array<string | null> = [];

vi.mock('@/shared/api', () => ({
  api: {
    getFileTreeWithIgnored: async () => jsonResponse(projectTree),
    getFileTreeLocation: async () => jsonResponse({ path: ROOT, displayPath: ROOT, parentPath: OUTSIDE, insideProject: true }),
    getFileTreeDirectory: async (_projectId: string, directoryPath: string | null) => {
      requestedDirectories.push(directoryPath);
      if (directoryPath === `${ROOT}/node_modules`) {
        return jsonResponse({
          path: directoryPath,
          displayPath: directoryPath,
          parentPath: ROOT,
          insideProject: true,
          entries: [{ type: 'directory', name: 'left-pad', path: `${ROOT}/node_modules/left-pad` }],
          truncated: false,
        });
      }
      return jsonResponse({
        path: OUTSIDE,
        displayPath: OUTSIDE,
        parentPath: '/',
        insideProject: false,
        entries: [
          { type: 'directory', name: 'sandbox', path: ROOT },
          { type: 'file', name: 'notes.txt', path: `${OUTSIDE}/notes.txt` },
        ],
        truncated: false,
      });
    },
  },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'sandbox', fullPath: ROOT, path: ROOT };

beforeEach(() => {
  requestedDirectories.length = 0;
});

test('an ignored folder is listed dimmed and its contents are read when it is opened', async () => {
  render(<FileTree selectedProject={project} />);

  const folderName = await screen.findByText('node_modules');
  assert.match(folderName.closest('.group')?.className ?? '', /opacity-60/);
  assert.equal(screen.queryByText('left-pad'), null);

  fireEvent.click(folderName);

  const child = await screen.findByText('left-pad');
  assert.deepEqual(requestedDirectories, [`${ROOT}/node_modules`]);
  // Inside an ignored folder everything is shown as ignored.
  assert.match(child.closest('.group')?.className ?? '', /opacity-60/);
});

test('the parent folder opens read-only, and the project root brings the writing actions back', async () => {
  render(<FileTree selectedProject={project} />);
  await screen.findByText('README.md');
  assert.ok(screen.getByLabelText('New Folder (Cmd+Shift+N)'));

  fireEvent.click(screen.getByLabelText('Parent folder'));

  await screen.findByText('notes.txt');
  assert.deepEqual(requestedDirectories, [OUTSIDE]);
  assert.equal(screen.queryByLabelText('New Folder (Cmd+Shift+N)'), null);
  assert.equal((screen.getByLabelText('Folder shown in the tree') as HTMLInputElement).value, OUTSIDE);

  fireEvent.click(screen.getByLabelText('Back to the project folder'));

  await screen.findByText('README.md');
  await waitFor(() => assert.ok(screen.getByLabelText('New Folder (Cmd+Shift+N)')));
});

test('a path typed into the location bar is opened', async () => {
  render(<FileTree selectedProject={project} />);
  await screen.findByText('README.md');

  const pathInput = screen.getByLabelText('Folder shown in the tree');
  fireEvent.focus(pathInput);
  fireEvent.change(pathInput, { target: { value: `  ${OUTSIDE}  ` } });
  fireEvent.keyDown(pathInput, { key: 'Enter' });

  await screen.findByText('notes.txt');
  assert.deepEqual(requestedDirectories, [OUTSIDE]);
});
