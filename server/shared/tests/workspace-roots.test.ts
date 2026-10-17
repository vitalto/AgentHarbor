import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findForbiddenWorkspaceAncestor, listWindowsDriveRoots, validateWorkspacePath } from '@/shared/utils.js';

// Beside this file rather than under the temp directory, which is a forbidden workspace location.
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await realpath(await mkdtemp(path.join(testDirectory, 'workspace-roots-fixture-')));

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

const WINDOWS_CLAUDE_ENV = { AH_CLAUDE_CMD: '/mnt/c/Users/alice/.local/bin/claude.exe' };

test('only single-letter mounts count as Windows drives, and only for a Windows Claude', async () => {
  const mountRoot = path.join(fixtureRoot, 'mnt');
  for (const name of ['d', 'c', 'wsl', 'wslg', 'usb_flash']) {
    await mkdir(path.join(mountRoot, name), { recursive: true });
  }

  assert.deepEqual(await listWindowsDriveRoots(WINDOWS_CLAUDE_ENV, mountRoot), [
    path.join(mountRoot, 'c'),
    path.join(mountRoot, 'd'),
  ]);
  assert.deepEqual(await listWindowsDriveRoots({ AH_CLAUDE_CMD: 'claude' }, mountRoot), []);
  assert.deepEqual(await listWindowsDriveRoots(WINDOWS_CLAUDE_ENV, path.join(fixtureRoot, 'missing')), []);
});

test('Windows system folders stay forbidden when reached through the drive mount, in any case', () => {
  assert.equal(findForbiddenWorkspaceAncestor('/mnt/c/Windows'), '/mnt/c/windows');
  assert.equal(findForbiddenWorkspaceAncestor('/mnt/c/WINDOWS/System32'), '/mnt/c/windows');
  assert.equal(findForbiddenWorkspaceAncestor('/mnt/c/Program Files (x86)/Tool'), '/mnt/c/program files (x86)');
  assert.equal(findForbiddenWorkspaceAncestor('/mnt/c/Users/alice/SampleProject'), null);
  assert.equal(findForbiddenWorkspaceAncestor('/mnt/d/Develop/SampleProject'), null);
  assert.equal(findForbiddenWorkspaceAncestor('/etc/nginx'), '/etc');
  assert.equal(findForbiddenWorkspaceAncestor('/var/tmp/sandbox'), null);
});

test('a workspace may live under any of the allowed roots', async () => {
  const homeRoot = path.join(fixtureRoot, 'home');
  const driveRoot = path.join(fixtureRoot, 'drive-d');
  const outsideRoot = path.join(fixtureRoot, 'outside');
  await mkdir(path.join(driveRoot, 'Develop'), { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const roots = [homeRoot, driveRoot];

  const onDrive = await validateWorkspacePath(path.join(driveRoot, 'Develop', 'NewProject'), roots);
  assert.equal(onDrive.valid, true);
  assert.equal(onDrive.resolvedPath, path.join(driveRoot, 'Develop', 'NewProject'));

  assert.equal((await validateWorkspacePath(path.join(homeRoot, 'sandbox'), roots)).valid, true);

  const outside = await validateWorkspacePath(path.join(outsideRoot, 'sandbox'), roots);
  assert.equal(outside.valid, false);
  assert.match(outside.error ?? '', /allowed workspace root/);
});
