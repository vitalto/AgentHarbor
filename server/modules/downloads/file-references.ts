import { promises as fs } from 'node:fs';
import path from 'node:path';

// Agents shorten long paths with an ellipsis: `…\scratchpad\icon.png`, `...\out\a.txt`.
const LEADING_ELLIPSIS = /^(?:…|\.\.\.)[\\/]/;
const LEADING_CURRENT_DIR = /^(?:\.[\\/])+/;

async function isFile(localPath: string): Promise<boolean> {
  try {
    return (await fs.stat(localPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Where an elided path can continue a root: `…\scratchpad\a.png` against
 * `/t/claude/X/sid` is `/t/claude/X/sid/scratchpad/a.png`, and against
 * `/t/claude/X/sid/scratchpad/icon` it is `/t/claude/X/sid/scratchpad/a.png`.
 */
function splicedOntoRoot(root: string, relativePath: string): string[] {
  const [firstSegment] = relativePath.split('/');
  const rootSegments = root.split('/');
  const candidates = [path.posix.join(root, relativePath)];
  for (let index = rootSegments.length - 1; index > 0; index -= 1) {
    if (rootSegments[index] === firstSegment) {
      candidates.push(path.posix.join(rootSegments.slice(0, index).join('/') || '/', relativePath));
    }
  }
  return candidates;
}

/**
 * The file on this machine a path written by an agent names, or null when no
 * such file exists. Absolute paths are taken as they are; relative and
 * ellipsis-shortened ones are looked up under each root in order (the project,
 * then the session's temp folder that holds its scratchpad).
 */
export async function resolveFileReference(
  reference: string,
  roots: string[],
  toLocalPath: (claudePath: string) => string,
): Promise<string | null> {
  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }

  const localPath = toLocalPath(trimmed);
  if (path.posix.isAbsolute(localPath)) {
    return (await isFile(localPath)) ? localPath : null;
  }

  const isElided = LEADING_ELLIPSIS.test(trimmed);
  const relativePath = trimmed.replace(LEADING_ELLIPSIS, '').replace(LEADING_CURRENT_DIR, '').replace(/\\/g, '/');
  if (!relativePath) {
    return null;
  }

  for (const root of roots) {
    const candidates = isElided ? splicedOntoRoot(root, relativePath) : [path.posix.join(root, relativePath)];
    for (const candidate of candidates) {
      if (await isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
