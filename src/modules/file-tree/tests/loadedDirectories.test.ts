import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  EMPTY_DIRECTORY_LOAD_STATE,
  findUnloadedOpenDirectories,
  mergeLoadedDirectories,
} from '@/modules/file-tree/utils/loadedDirectories';
import type { FileTreeNode } from '@/shared/types';

const ROOT = '/workspace/sandbox';

const serverTree: FileTreeNode[] = [
  { type: 'directory', name: 'node_modules', path: `${ROOT}/node_modules`, ignored: true },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [{ type: 'directory', name: 'deep', path: `${ROOT}/src/deep` }],
  },
  { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
];

test('an ignored folder fetched on demand shows its contents as ignored too', () => {
  const merged = mergeLoadedDirectories(serverTree, {
    ...EMPTY_DIRECTORY_LOAD_STATE,
    loaded: new Map([[`${ROOT}/node_modules`, {
      entries: [{ type: 'file', name: 'index.js', path: `${ROOT}/node_modules/index.js` }],
      truncated: true,
    }]]),
  });

  const nodeModules = merged[0];
  assert.equal(nodeModules?.ignored, true);
  assert.equal(nodeModules?.childrenTruncated, true);
  assert.deepEqual(nodeModules?.children?.map((child) => [child.name, child.ignored]), [['index.js', true]]);
  assert.notEqual(merged[2]?.ignored, true);
});

test('a folder the server already walked keeps its own children', () => {
  const merged = mergeLoadedDirectories(serverTree, {
    ...EMPTY_DIRECTORY_LOAD_STATE,
    loaded: new Map([[`${ROOT}/src`, { entries: [], truncated: false }]]),
  });

  assert.deepEqual(merged[1]?.children?.map((child) => child.name), ['deep']);
});

test('only open folders that were never fetched are asked for', () => {
  const expanded = new Set([`${ROOT}/node_modules`, `${ROOT}/src`, `${ROOT}/src/deep`]);

  assert.deepEqual(
    findUnloadedOpenDirectories(mergeLoadedDirectories(serverTree, EMPTY_DIRECTORY_LOAD_STATE), expanded),
    [`${ROOT}/node_modules`, `${ROOT}/src/deep`],
  );

  const inFlightOrFailed = mergeLoadedDirectories(serverTree, {
    ...EMPTY_DIRECTORY_LOAD_STATE,
    loading: new Set([`${ROOT}/node_modules`]),
    failed: new Map([[`${ROOT}/src/deep`, 'Permission denied']]),
  });
  assert.deepEqual(findUnloadedOpenDirectories(inFlightOrFailed, expanded), []);
  assert.equal(inFlightOrFailed[0]?.childrenLoading, true);
  assert.equal(inFlightOrFailed[1]?.children?.[0]?.childrenError, 'Permission denied');
});

test('a closed folder is not fetched, even inside an open one', () => {
  const merged = mergeLoadedDirectories(serverTree, EMPTY_DIRECTORY_LOAD_STATE);
  assert.deepEqual(findUnloadedOpenDirectories(merged, new Set([`${ROOT}/src/deep`])), []);
});
