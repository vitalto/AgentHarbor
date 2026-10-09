import fsp from 'node:fs/promises';

export type TranscriptPoll = {
  rows: unknown[];
  /** The file shrank or was replaced: everything read so far is void and callers should resync. */
  reset: boolean;
};

const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Incremental reader for an append-only JSONL transcript.
 *
 * Polling (not inotify) on purpose: writes made by a Windows process into a
 * WSL /mnt/<drive> path raise no inotify events. A trailing line without its
 * newline is still being written and is held back until it is complete.
 */
export function createTranscriptTail(filePath: string, startOffset?: number) {
  let offset = startOffset ?? -1;
  let pending = Buffer.alloc(0);

  async function currentSize(): Promise<number | null> {
    try {
      return (await fsp.stat(filePath)).size;
    } catch {
      return null;
    }
  }

  return {
    offset: () => offset,

    async poll(): Promise<TranscriptPoll> {
      const size = await currentSize();
      if (size === null) {
        // A transcript that does not exist yet belongs to a new session: read it from its first row.
        if (offset < 0) {
          offset = 0;
        }
        return { rows: [], reset: false };
      }
      if (offset < 0) {
        offset = size;
        return { rows: [], reset: false };
      }
      if (size < offset) {
        offset = 0;
        pending = Buffer.alloc(0);
        return { rows: [], reset: true };
      }
      if (size === offset) {
        return { rows: [], reset: false };
      }

      const length = Math.min(size - offset, MAX_READ_BYTES);
      const chunk = Buffer.alloc(length);
      const handle = await fsp.open(filePath, 'r');
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, length, offset));
      } finally {
        await handle.close();
      }
      offset += bytesRead;

      const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        pending = data;
        return { rows: [], reset: false };
      }
      pending = data.subarray(lastNewline + 1);

      const rows: unknown[] = [];
      for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          rows.push(JSON.parse(line));
        } catch {
          // A corrupt line cannot be repaired by waiting; skip it like Claude's own reader does.
        }
      }
      return { rows, reset: false };
    },
  };
}

export type TranscriptTail = ReturnType<typeof createTranscriptTail>;
