import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { getCodexCliConfig } from '@/modules/tmux/codex-cli.js';
import { toClaudePath } from '@/modules/tmux/path-translation.js';

const uuidLock = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;

export async function listLockedCodexThreads(): Promise<string[]> {
  const { home, pathConfig } = getCodexCliConfig();
  const dir = path.join(home, 'thread-writer-locks');
  let names: string[];
  try { names = (await fs.readdir(dir)).filter((name) => uuidLock.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!names.length) return [];
  if (process.platform === 'win32' || pathConfig.windowsClaude) {
    const nativeDir = toClaudePath(dir, pathConfig);
    // ReadByte on Codex's exclusive byte-range lock fails with ERROR_LOCK_VIOLATION
    // even on its empty file. This probe never acquires a writer lock itself.
    const script = `$ErrorActionPreference='Stop'
Get-ChildItem -LiteralPath '${nativeDir.replace(/'/g, "''")}' -Filter '*.lock' -File | ForEach-Object {
  if ($_.BaseName -notmatch '^[0-9a-f-]{36}$') { return }
  $streamName = $_.BaseName
  $stream = $null
  try {
    $stream = [IO.File]::Open($_.FullName,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    [void]$stream.ReadByte()
  } catch {
    $code = $_.Exception.GetBaseException().HResult -band 65535
    if ($code -in 32,33) { Write-Output $streamName } elseif ($code -notin 2,3) { throw }
  } finally { if ($stream) { $stream.Dispose() } }
}`;
    const executable = pathConfig.windowsClaude ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : 'powershell.exe';
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 });
    return stdout.trim().split(/\s+/).filter((id) => uuidLock.test(id + '.lock'));
  }
  const locks = await fs.readFile('/proc/locks', 'utf8');
  const lockedFiles = new Set([...locks.matchAll(/\bWRITE\s+-?\d+\s+([\da-f]+):([\da-f]+):(\d+)/gi)]
    .map(([, major, minor, inode]) => `${parseInt(major, 16)}:${parseInt(minor, 16)}:${inode}`));
  const held = await Promise.all(names.map(async (name) => {
    const stat = await fs.stat(path.join(dir, name), { bigint: true }).catch((error) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (!stat) return null;
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & ~0xfffn);
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & ~0xffn);
    return lockedFiles.has(`${major}:${minor}:${stat.ino}`) ? name.slice(0, -5) : null;
  }));
  return held.filter((id): id is string => id !== null);
}
