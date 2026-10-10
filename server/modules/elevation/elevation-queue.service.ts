import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * A command an agent queued with `elevate` (TerminalShare/windows/elevation): it runs elevated
 * only after the user approves it here. The Windows broker that executes it is a separate,
 * elevated process watching the same folder.
 */
export type ElevationRequest = {
  id: string;
  command: string;
  /** Windows path the command runs in. */
  cwd: string;
  requestedAt: string;
  /** Windows pid of the claude.exe that asked, when `elevate` ran under one. */
  claudePid: number | null;
  sessionId: string | null;
  sessionTitle: string | null;
};

export type ElevationQueueSnapshot = {
  /** The broker refreshes its heartbeat every second; without it an approval would never run. */
  brokerOnline: boolean;
  requests: ElevationRequest[];
};

export type ElevationSession = { sessionId: string; title: string | null };

export class ElevationRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending elevation request ${id}`);
  }
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
// `elevate` touches its request every second; the broker refuses requests silent for 30 s.
const CLIENT_SILENCE_LIMIT_MS = 20_000;
const BROKER_SILENCE_LIMIT_MS = 15_000;

/** Must match Get-RequestHash in broker.ps1: an approval only runs the exact text that was shown. */
function hashRequest(request: Pick<ElevationRequest, 'cwd' | 'command'>): string {
  return createHash('sha256').update(`${request.cwd}\n${request.command}`, 'utf8').digest('hex');
}

async function modifiedAt(filePath: string): Promise<number | null> {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

function parseRequest(id: string, text: string): Omit<ElevationRequest, 'sessionId' | 'sessionTitle'> | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.id !== id || typeof raw.command !== 'string' || typeof raw.cwd !== 'string' || !raw.command || !raw.cwd) {
    return null;
  }
  return {
    id,
    command: raw.command,
    cwd: raw.cwd,
    requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : new Date(0).toISOString(),
    claudePid: typeof raw.claudePid === 'number' && raw.claudePid > 0 ? raw.claudePid : null,
  };
}

export type ElevationQueue = {
  read(): Promise<ElevationQueueSnapshot>;
  /** Records the user's answer for the broker; throws ElevationRequestNotFoundError once the request is gone or answered. */
  decide(id: string, approved: boolean): Promise<void>;
};

/** Used by the elevation module's barrel (and its tests, with a temporary queue folder). */
export function createElevationQueue({
  queueDir,
  findSessionByClaudePid,
  now = Date.now,
}: {
  queueDir: string;
  findSessionByClaudePid: (claudePid: number) => Promise<ElevationSession | null>;
  now?: () => number;
}): ElevationQueue {
  const requestsDir = path.join(queueDir, 'requests');
  const decisionsDir = path.join(queueDir, 'decisions');
  const resultsDir = path.join(queueDir, 'results');

  const readPendingRequest = async (id: string) => {
    if (!REQUEST_ID_PATTERN.test(id)) {
      return null;
    }
    const requestPath = path.join(requestsDir, `${id}.json`);
    const heartbeat = await modifiedAt(requestPath);
    if (heartbeat === null || now() - heartbeat > CLIENT_SILENCE_LIMIT_MS) {
      return null;
    }
    const [decided, finished] = await Promise.all([
      modifiedAt(path.join(decisionsDir, `${id}.json`)),
      modifiedAt(path.join(resultsDir, `${id}.json`)),
    ]);
    if (decided !== null || finished !== null) {
      return null;
    }
    try {
      return parseRequest(id, await fsp.readFile(requestPath, 'utf8'));
    } catch {
      return null;
    }
  };

  return {
    async read() {
      const brokerHeartbeat = await modifiedAt(path.join(queueDir, 'broker.alive'));
      let names: string[] = [];
      try {
        names = await fsp.readdir(requestsDir);
      } catch {
        // No folder yet: nothing has ever been requested.
      }
      const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
      const pending = (await Promise.all(ids.map(readPendingRequest))).filter((request) => request !== null);
      const requests = await Promise.all(pending.map(async (request) => {
        const session = request.claudePid ? await findSessionByClaudePid(request.claudePid) : null;
        return { ...request, sessionId: session?.sessionId ?? null, sessionTitle: session?.title ?? null };
      }));
      requests.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
      return {
        brokerOnline: brokerHeartbeat !== null && now() - brokerHeartbeat <= BROKER_SILENCE_LIMIT_MS,
        requests,
      };
    },

    async decide(id, approved) {
      const request = await readPendingRequest(id);
      if (!request) {
        throw new ElevationRequestNotFoundError(id);
      }
      await fsp.mkdir(decisionsDir, { recursive: true });
      const decision = { id, approved, requestHash: hashRequest(request), decidedAt: new Date(now()).toISOString() };
      // The broker polls this folder; a rename keeps it from reading a half-written file.
      const partialPath = path.join(decisionsDir, `${id}.partial`);
      await fsp.writeFile(partialPath, JSON.stringify(decision));
      await fsp.rename(partialPath, path.join(decisionsDir, `${id}.json`));
    },
  };
}
