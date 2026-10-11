import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

// A transcript page mentions many paths at once; they go to the server in one
// request per session instead of one each.
const MAX_REFERENCES_PER_REQUEST = 200;
// The agent may name a file a moment before it writes it, so "not found" is retried after this.
const MISSING_FILE_RETRY_MS = 30_000;

type CachedResolution = { localPath: Promise<string | null>; missingSince?: number };

const resolutions = new Map<string, CachedResolution>();
const queuedBySession = new Map<string, Map<string, (localPath: string | null) => void>>();
let flushScheduled = false;

const cacheKey = (sessionId: string, reference: string) => `${sessionId}\n${reference}`;

async function resolveBatch(sessionId: string, batch: Map<string, (localPath: string | null) => void>) {
  const references = Array.from(batch.keys());
  let resolved: Record<string, string | null> = {};
  try {
    ({ resolved } = await readApiJson<{ resolved: Record<string, string | null> }>(
      await api.downloads.resolve(sessionId || null, references),
    ));
  } catch {
    // Treated as missing; the retry window brings the paths back for another try.
  }
  for (const reference of references) {
    const localPath = resolved[reference] ?? null;
    if (!localPath) {
      const cached = resolutions.get(cacheKey(sessionId, reference));
      if (cached) {
        cached.missingSince = Date.now();
      }
    }
    batch.get(reference)?.(localPath);
  }
}

function flushQueuedReferences() {
  flushScheduled = false;
  for (const [sessionId, queued] of queuedBySession) {
    queuedBySession.delete(sessionId);
    const entries = Array.from(queued);
    for (let start = 0; start < entries.length; start += MAX_REFERENCES_PER_REQUEST) {
      void resolveBatch(sessionId, new Map(entries.slice(start, start + MAX_REFERENCES_PER_REQUEST)));
    }
  }
}

/** The local path of the file `reference` names in this session's chat, or null when there is none. */
export function resolveFileReference(sessionId: string | null, reference: string): Promise<string | null> {
  const session = sessionId ?? '';
  const key = cacheKey(session, reference);
  const cached = resolutions.get(key);
  if (cached && !(cached.missingSince && Date.now() - cached.missingSince > MISSING_FILE_RETRY_MS)) {
    return cached.localPath;
  }

  const localPath = new Promise<string | null>((resolve) => {
    const queued = queuedBySession.get(session) ?? new Map();
    queued.set(reference, resolve);
    queuedBySession.set(session, queued);
  });
  resolutions.set(key, { localPath });
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(flushQueuedReferences, 0);
  }
  return localPath;
}

export function useResolvedFileReference(sessionId: string | null, reference: string | null): string | null {
  const [resolved, setResolved] = useState<{ key: string; localPath: string | null } | null>(null);
  const key = reference ? cacheKey(sessionId ?? '', reference) : '';

  useEffect(() => {
    if (!reference) {
      return;
    }
    let isCurrent = true;
    void resolveFileReference(sessionId, reference).then((localPath) => {
      if (isCurrent) {
        setResolved({ key, localPath });
      }
    });
    return () => {
      isCurrent = false;
    };
  }, [key, reference, sessionId]);

  return resolved && resolved.key === key ? resolved.localPath : null;
}
