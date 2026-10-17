import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceLocationsService } from '@/modules/projects/services/workspace-locations.service.js';
import { AppError } from '@/shared/utils.js';

const toWindowsPath = (localPath: string) => {
  const mounted = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(localPath);
  return mounted ? `${mounted[1].toUpperCase()}:\\${(mounted[2] ?? '').replace(/\//g, '\\')}` : localPath;
};
const fromWindowsPath = (displayPath: string) => {
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(displayPath);
  return drive ? `/mnt/${drive[1].toLowerCase()}${drive[2] ? `/${drive[2].replace(/\\/g, '/')}` : ''}` : displayPath;
};

function createService(overrides: Partial<Parameters<typeof createWorkspaceLocationsService>[0]> = {}) {
  let storedDirectory: string | null = null;
  const service = createWorkspaceLocationsService({
    readStoredProjectsDirectory: () => storedDirectory,
    storeProjectsDirectory: (localPath) => {
      storedDirectory = localPath;
    },
    defaultProjectsDirectory: null,
    homeDirectory: '/home/alice',
    listDriveRoots: async () => ['/mnt/c', '/mnt/d'],
    listSubdirectoryNames: async () => ['beta', '.git-cache', 'Alpha', 'SampleProject', 'project10', 'project9'],
    isDirectory: async () => true,
    listActiveProjects: () => [{ project_id: 'p-1', project_path: '/mnt/d/develop/sampleproject' }],
    validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
    toLocalPath: fromWindowsPath,
    toDisplayPath: toWindowsPath,
    ...overrides,
  });
  return { service, readStored: () => storedDirectory };
}

test('without a projects folder only the places are listed', async () => {
  const { service } = createService();
  const locations = await service.getLocations();

  assert.equal(locations.projectsDirectory, null);
  assert.deepEqual(locations.projectsDirectoryFolders, []);
  assert.deepEqual(locations.places, [
    { label: '~', path: '/home/alice' },
    { label: 'C:', path: 'C:\\' },
    { label: 'D:', path: 'D:\\' },
  ]);
});

test('the projects folder lists its visible subfolders in natural order and marks registered projects', async () => {
  const { service } = createService({ defaultProjectsDirectory: 'D:\\Develop' });
  const locations = await service.getLocations();

  assert.equal(locations.projectsDirectory, 'D:\\Develop');
  assert.deepEqual(
    locations.projectsDirectoryFolders.map((folder) => folder.name),
    ['Alpha', 'beta', 'project9', 'project10', 'SampleProject'],
  );
  const sampleProject = locations.projectsDirectoryFolders.find((folder) => folder.name === 'SampleProject');
  assert.deepEqual(sampleProject, { name: 'SampleProject', path: 'D:\\Develop\\SampleProject', projectId: 'p-1' });
  assert.equal(locations.projectsDirectoryFolders.find((folder) => folder.name === 'Alpha')?.projectId, null);
});

test('choosing a projects folder stores it as a server path and clearing returns to the default', async () => {
  const { service, readStored } = createService({ defaultProjectsDirectory: 'C:\\Users\\alice' });

  const chosen = await service.setProjectsDirectory('D:\\Develop\\');
  assert.equal(readStored(), '/mnt/d/Develop');
  assert.equal(chosen.projectsDirectory, 'D:\\Develop');

  const cleared = await service.setProjectsDirectory(null);
  assert.equal(readStored(), null);
  assert.equal(cleared.projectsDirectory, 'C:\\Users\\alice');
});

test('a projects folder outside the allowed roots or missing is refused', async () => {
  const blocked = createService({ validatePath: async () => ({ valid: false, error: 'outside' }) });
  await assert.rejects(blocked.service.setProjectsDirectory('/etc'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'INVALID_PROJECTS_DIRECTORY');
    return true;
  });
  assert.equal(blocked.readStored(), null);

  const missing = createService({ isDirectory: async () => false });
  await assert.rejects(missing.service.setProjectsDirectory('D:\\Nowhere'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'PROJECTS_DIRECTORY_NOT_FOUND');
    return true;
  });
});
