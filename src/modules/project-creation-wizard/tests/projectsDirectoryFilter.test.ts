import assert from 'node:assert/strict';

import { test } from 'vitest';

import { isValidFolderName } from '@/modules/project-creation-wizard/utils/pathUtils';
import { matchProjectsDirectoryFolders } from '@/modules/project-creation-wizard/utils/projectsDirectoryFilter';

const folder = (name: string, projectId: string | null = null) => ({
  name,
  path: `D:\\Develop\\${name}`,
  projectId,
});

const folders = [folder('AgentHarbor', 'p-1'), folder('Harbor'), folder('SampleProject'), folder('sandbox')];

test('an empty query lists every folder and offers nothing to create', () => {
  assert.deepEqual(matchProjectsDirectoryFolders(folders, '  '), { folders, newFolderName: null });
});

test('name prefixes rank above inner matches, ignoring case', () => {
  const matches = matchProjectsDirectoryFolders(folders, 'harb');
  assert.deepEqual(matches.folders.map((match) => match.name), ['Harbor', 'AgentHarbor']);
  assert.equal(matches.newFolderName, 'harb');
});

test('a name an existing folder already has, in any case, is not offered for creation', () => {
  const matches = matchProjectsDirectoryFolders(folders, 'SANDBOX');
  assert.deepEqual(matches.folders.map((match) => match.name), ['sandbox']);
  assert.equal(matches.newFolderName, null);
});

test('a name Windows cannot hold is not offered for creation', () => {
  assert.equal(matchProjectsDirectoryFolders(folders, 'a:b').newFolderName, null);
  assert.equal(isValidFolderName('new-app'), true);
  assert.equal(isValidFolderName('Мой проект'), true);
  assert.equal(isValidFolderName('trailing.'), false);
  assert.equal(isValidFolderName('..'), false);
  assert.equal(isValidFolderName('a/b'), false);
});
