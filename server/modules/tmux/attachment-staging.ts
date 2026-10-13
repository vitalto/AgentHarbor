import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getAgentConfig, type AgentConfig } from '@/modules/tmux/agent-config.js';
import { toClaudePath } from '@/modules/tmux/path-translation.js';

export const ATTACHMENTS_DIRECTORY = 'attachments';
const DAY_MS = 24 * 60 * 60 * 1000;

const isWslSharePath = (claudePath: string) => claudePath.startsWith('\\\\');

async function pruneStagedAttachments(stagingDirectory: string, maxAgeMs: number, now: number): Promise<void> {
  for (const name of await fs.readdir(stagingDirectory)) {
    const stagedPath = path.join(stagingDirectory, name);
    try {
      if (now - (await fs.stat(stagedPath)).mtimeMs > maxAgeMs) {
        await fs.unlink(stagedPath);
      }
    } catch {
      // Another send may have pruned it first.
    }
  }
}

/**
 * Expresses an uploaded file as the path Claude should be given. A Windows
 * Claude reaches this server's Linux files only as `\\wsl.localhost\…`, which
 * its TUI neither attaches as an image nor keeps intact (it drops a
 * backslash), so such a file is copied into the state directory on the
 * Windows drive first.
 */
export async function stageAttachmentForClaude(
  localPath: string,
  config: AgentConfig = getAgentConfig(),
  now: number = Date.now(),
): Promise<string> {
  const claudePath = toClaudePath(localPath, config);
  const stagingDirectory = path.join(config.stateDir, ATTACHMENTS_DIRECTORY);
  if (!config.windowsClaude || !isWslSharePath(claudePath) || isWslSharePath(toClaudePath(stagingDirectory, config))) {
    return claudePath;
  }

  await fs.mkdir(stagingDirectory, { recursive: true });
  await pruneStagedAttachments(stagingDirectory, config.attachmentRetentionDays * DAY_MS, now);
  const stagedPath = path.join(stagingDirectory, path.basename(localPath));
  await fs.copyFile(localPath, stagedPath);
  return toClaudePath(stagedPath, config);
}
