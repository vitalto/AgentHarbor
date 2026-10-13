import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

/**
 * A chat tool card opens any file an agent touched, e.g. a render under
 * C:\AI, while the project file API refuses everything outside the project
 * with 403. Such files are read like the chat's own previews, through the
 * downloads endpoint.
 */

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
const outsideProject = () => jsonResponse(403, { error: 'Path must be under project root' });

const readFile = vi.fn();
const readFileBlob = vi.fn();
const downloadsContent = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    api: { readFile, readFileBlob, downloads: { content: downloadsContent } },
  };
});

const { fetchEditorFileBlob, readEditorFileText } = await import('@/modules/code-editor/utils/readEditorFile');

const renderPath = 'C:\\AI\\outputs\\video\\sweeping\\grid.png';

beforeEach(() => {
  readFile.mockReset();
  readFileBlob.mockReset();
  downloadsContent.mockReset();
});

test('media outside the project is fetched through the downloads endpoint', async () => {
  readFileBlob.mockResolvedValue(outsideProject());
  downloadsContent.mockResolvedValue(new Response('png bytes', { status: 200 }));

  const response = await fetchEditorFileBlob('p1', renderPath);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'png bytes');
  assert.equal(downloadsContent.mock.calls[0][0], renderPath);
});

test('media inside the project never touches the downloads endpoint', async () => {
  readFileBlob.mockResolvedValue(new Response('project bytes', { status: 200 }));

  assert.equal(await (await fetchEditorFileBlob('p1', '/repo/logo.png')).text(), 'project bytes');
  assert.equal(downloadsContent.mock.calls.length, 0);
});

test('a refused relative path stays refused: only absolute paths name a file outside the project', async () => {
  readFileBlob.mockResolvedValue(outsideProject());

  assert.equal((await fetchEditorFileBlob('p1', '../escape.png')).status, 403);
  assert.equal(downloadsContent.mock.calls.length, 0);
});

test('text outside the project is read through the downloads endpoint', async () => {
  readFile.mockResolvedValue(outsideProject());
  downloadsContent.mockResolvedValue(new Response('{"seed": 7}', { status: 200 }));

  assert.equal(await readEditorFileText('p1', '/mnt/c/AI/outputs/run.json'), '{"seed": 7}');
});

test('text inside the project comes from the project file API', async () => {
  readFile.mockResolvedValue(jsonResponse(200, { content: 'hello' }));

  assert.equal(await readEditorFileText('p1', '/repo/a.txt'), 'hello');
  assert.equal(downloadsContent.mock.calls.length, 0);
});

test('when the file is missing either way, the project API explains why', async () => {
  readFile.mockResolvedValue(outsideProject());
  downloadsContent.mockResolvedValue(jsonResponse(404, { error: 'File not found' }));

  await assert.rejects(readEditorFileText('p1', 'C:\\AI\\gone.json'), /Path must be under project root/);
});
