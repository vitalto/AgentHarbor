import fsSync from 'node:fs';
import readline from 'node:readline';

import { spawn } from 'cross-spawn';
import { rgPath } from '@vscode/ripgrep';

const FILE_CHUNK_SIZE = 40;
// Each rg.exe start crosses WSL interop, so it gets bigger chunks; 150 drive
// paths stay well under the 32767-character Windows command line.
const WINDOWS_FILE_CHUNK_SIZE = 150;
const CHUNK_CONCURRENCY = 6;
// Longer transcript lines are tool output and injected context; real chat
// messages fit, and printing those lines would multiply the bytes to parse.
const MAX_LINE_LENGTH = 100_000;
// What ripgrep prints instead of a longer line ("[Omitted long matching line]").
const OMITTED_LINE_PREFIX = '[Omitted long';

const WSL_DRIVE_PATH = /^\/mnt\/([a-z])(?:\/(.*))?$/;
const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

type RipgrepRunner = {
  command: string;
  toArgumentPath: (localPath: string) => string;
  fromOutputPath: (printedPath: string) => string;
};

const linuxRipgrep: RipgrepRunner = {
  command: rgPath,
  toArgumentPath: (localPath) => localPath,
  fromOutputPath: (printedPath) => printedPath,
};

export function wslPathToWindowsPath(localPath: string): string | null {
  const match = WSL_DRIVE_PATH.exec(localPath);
  if (!match) {
    return null;
  }
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`;
}

export function windowsPathToWslPath(windowsPath: string): string {
  const match = WINDOWS_DRIVE_PATH.exec(windowsPath);
  if (!match) {
    return windowsPath;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/**
 * A Windows ripgrep (`AH_WINDOWS_RIPGREP`, a WSL path to rg.exe) for files on
 * /mnt/<drive>. Linux ripgrep reads those through the 9p mount: about 4 s for
 * the ~1.7 GB of transcripts on one machine, against 0.4 s for rg.exe reading
 * NTFS directly. Unset or missing, every file goes to the bundled Linux one.
 */
function windowsRipgrepFromEnvironment(): RipgrepRunner | null {
  const command = process.env.AH_WINDOWS_RIPGREP?.trim();
  if (!command || !fsSync.existsSync(command)) {
    return null;
  }
  return {
    command,
    toArgumentPath: (localPath) => wslPathToWindowsPath(localPath) ?? localPath,
    fromOutputPath: windowsPathToWslPath,
  };
}

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  const chunks: TItem[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Streams the lines of one file chunk that hold at least one search string,
 * grouped by file. ripgrep prints all matches of one file together, so a
 * change of path marks the end of the previous file.
 */
async function streamChunk(
  runner: RipgrepRunner,
  searchStrings: string[],
  filePaths: string[],
  onFileLines: (filePath: string, lines: string[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    '--no-messages',
    '--ignore-case',
    '--fixed-strings',
    '--with-filename',
    '--null',
    '--no-line-number',
    '--max-columns',
    String(MAX_LINE_LENGTH),
    ...searchStrings.flatMap((searchString) => ['-e', searchString]),
    '--',
    ...filePaths.map(runner.toArgumentPath),
  ];

  await new Promise<void>((resolve, reject) => {
    const rg = spawn(runner.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let currentFilePath: string | null = null;
    let currentFileLines: string[] = [];

    const flushCurrentFile = () => {
      if (currentFilePath !== null && currentFileLines.length > 0) {
        onFileLines(runner.fromOutputPath(currentFilePath), currentFileLines);
      }
      currentFilePath = null;
      currentFileLines = [];
    };

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };
    signal?.addEventListener('abort', abortListener, { once: true });

    const lineReader = readline.createInterface({ input: rg.stdout, crlfDelay: Infinity });
    lineReader.on('line', (outputLine) => {
      const separatorIndex = outputLine.indexOf('\0');
      if (separatorIndex === -1) {
        return;
      }
      const filePath = outputLine.slice(0, separatorIndex);
      const transcriptLine = outputLine.slice(separatorIndex + 1);
      if (filePath !== currentFilePath) {
        flushCurrentFile();
        currentFilePath = filePath;
      }
      if (!transcriptLine.startsWith(OMITTED_LINE_PREFIX)) {
        currentFileLines.push(transcriptLine);
      }
    });

    rg.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      signal?.removeEventListener('abort', abortListener);
      if (aborted || signal?.aborted) {
        resolve();
        return;
      }
      reject(error);
    });

    // 'close' comes after stdout has ended, so every line has been read.
    rg.on('close', (exitCode) => {
      signal?.removeEventListener('abort', abortListener);
      if (aborted || signal?.aborted) {
        resolve();
        return;
      }
      flushCurrentFile();
      if (exitCode !== 0 && exitCode !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(exitCode)}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Hands `onFileLines` every line holding at least one of `searchStrings`
 * (case-insensitive, literal), grouped by file and keyed by the path as given.
 *
 * One pass that prints only those lines replaces a files-with-matches pass
 * per word followed by a full read of each matching file in Node: on WSL the
 * transcripts sit on /mnt/<drive>, where every byte read is a 9p round trip.
 */
export async function scanTranscriptLines(
  searchStrings: string[],
  filePaths: string[],
  onFileLines: (filePath: string, lines: string[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (searchStrings.length === 0 || filePaths.length === 0 || signal?.aborted) {
    return;
  }

  const windowsRipgrep = windowsRipgrepFromEnvironment();
  const windowsDriveFiles = windowsRipgrep ? filePaths.filter((filePath) => WSL_DRIVE_PATH.test(filePath)) : [];
  const linuxFiles = windowsRipgrep ? filePaths.filter((filePath) => !WSL_DRIVE_PATH.test(filePath)) : filePaths;
  const jobs = [
    ...chunkArray(linuxFiles, FILE_CHUNK_SIZE).map((files) => ({ runner: linuxRipgrep, files })),
    ...(windowsRipgrep
      ? chunkArray(windowsDriveFiles, WINDOWS_FILE_CHUNK_SIZE).map((files) => ({ runner: windowsRipgrep, files }))
      : []),
  ];

  let nextJobIndex = 0;
  const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, jobs.length) }, async () => {
    while (nextJobIndex < jobs.length && !signal?.aborted) {
      const job = jobs[nextJobIndex];
      nextJobIndex += 1;
      await streamChunk(job.runner, searchStrings, job.files, onFileLines, signal);
    }
  });

  await Promise.all(workers);
}
