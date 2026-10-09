import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readAgentConfig } from '@/modules/tmux/agent-config.js';
import { stageAttachmentForClaude } from '@/modules/tmux/attachment-staging.js';

const WINDOWS_DRIVE_SCRATCH = '/mnt/c/Users/Public';

async function withUpload(run: (uploadPath: string) => Promise<void>): Promise<void> {
  const uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-upload-'));
  const uploadPath = path.join(uploadDirectory, '1791580771904-938532906-shot.png');
  await fs.writeFile(uploadPath, 'png bytes');
  try {
    await run(uploadPath);
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  }
}

test('a Linux Claude gets the upload path as it is', async () => {
  await withUpload(async (uploadPath) => {
    const config = readAgentConfig({ AH_CLAUDE_CMD: 'claude', AH_STATE_DIR: '/nonexistent-state' });
    assert.equal(await stageAttachmentForClaude(uploadPath, config), uploadPath);
  });
});

test('a Windows Claude keeps the wsl share path when the state directory is not on a Windows drive either', async () => {
  await withUpload(async (uploadPath) => {
    const config = readAgentConfig({ AH_CLAUDE_CMD: 'claude.exe', AH_STATE_DIR: '/nonexistent-state', WSL_DISTRO_NAME: 'Ubuntu' });
    assert.equal(
      await stageAttachmentForClaude(uploadPath, config),
      `\\\\wsl.localhost\\Ubuntu${uploadPath.replace(/\//g, '\\')}`,
    );
  });
});

test('a Windows Claude gets a copy on the Windows drive; copies older than a week are pruned', { skip: !existsSync(WINDOWS_DRIVE_SCRATCH) }, async () => {
  const stateDirectory = await fs.mkdtemp(path.join(WINDOWS_DRIVE_SCRATCH, 'ah-state-'));
  try {
    await withUpload(async (uploadPath) => {
      const config = readAgentConfig({ AH_CLAUDE_CMD: 'claude.exe', AH_STATE_DIR: stateDirectory, WSL_DISTRO_NAME: 'Ubuntu' });
      const stagingDirectory = path.join(stateDirectory, 'attachments');
      await fs.mkdir(stagingDirectory);
      const staleCopy = path.join(stagingDirectory, 'old.png');
      await fs.writeFile(staleCopy, 'old');
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await fs.utimes(staleCopy, eightDaysAgo, eightDaysAgo);

      const claudePath = await stageAttachmentForClaude(uploadPath, config);

      assert.equal(claudePath, `C:\\Users\\Public\\${path.basename(stateDirectory)}\\attachments\\${path.basename(uploadPath)}`);
      assert.equal(await fs.readFile(path.join(stagingDirectory, path.basename(uploadPath)), 'utf8'), 'png bytes');
      assert.deepEqual(await fs.readdir(stagingDirectory), [path.basename(uploadPath)]);
    });
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});
