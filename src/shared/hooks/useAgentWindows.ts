import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type AgentWindowActivity = 'busy' | 'waiting' | 'idle';

/**
 * A session whose Claude is running right now. `tmux` agents are fully
 * controllable; `windows`/`elsewhere` ones run in another terminal and can only
 * be watched (typing into them is not possible from here).
 */
export type AgentWindow = {
  sessionId: string;
  providerSessionId: string;
  title: string | null;
  projectPath: string | null;
  location: 'tmux' | 'windows' | 'elsewhere';
  windowName: string | null;
  pid: number | null;
  activity: AgentWindowActivity;
  /** More than one Claude process holds this session. */
  duplicateProcesses: boolean;
};

const POLL_MS = 4000;

/** A refused move; `code` is AGENT_BUSY_ELSEWHERE when the other Claude is not idle (retry with force). */
export class AgentMoveError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
  }
}

/**
 * One shared poll for every component that shows live windows (sidebar dots,
 * chat key bar), so mounting more consumers does not multiply requests.
 */
let snapshot: AgentWindow[] = [];
const listeners = new Set<(windows: AgentWindow[]) => void>();
let timer: number | null = null;

async function refreshAgentWindows(): Promise<void> {
  try {
    const response = await api.providers.agentWindows();
    const body = (await response.json()) as { success?: boolean; data?: AgentWindow[] };
    if (body.success && Array.isArray(body.data)) {
      snapshot = body.data;
      listeners.forEach((listener) => listener(snapshot));
    }
  } catch {
    // Keep the last snapshot; the next poll retries.
  }
}

function subscribe(listener: (windows: AgentWindow[]) => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    void refreshAgentWindows();
    timer = window.setInterval(() => void refreshAgentWindows(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function useAgentWindows() {
  const [windows, setWindows] = useState<AgentWindow[]>(snapshot);

  useEffect(() => subscribe(setWindows), []);

  const findWindow = useCallback(
    (sessionId: string | null | undefined) => windows.find((entry) => entry.sessionId === sessionId) ?? null,
    [windows],
  );

  const openWindow = useCallback(async (sessionId: string) => {
    const response = await api.providers.openAgentWindow(sessionId);
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } | string };
    await refreshAgentWindows();
    if (!response.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? 'Could not open the Claude window');
    }
  }, []);

  /** Ends Claude in the other terminal and continues the session in tmux; rejects with the server's reason. */
  const moveToTmux = useCallback(async (sessionId: string, options: { force?: boolean } = {}) => {
    const response = await api.providers.moveAgentToTmux(sessionId, options.force ?? false);
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } | string };
    await refreshAgentWindows();
    if (!response.ok) {
      const error = typeof body.error === 'string' ? { message: body.error } : body.error;
      throw new AgentMoveError(error?.message ?? 'Could not move the session to tmux', error?.code ?? null);
    }
  }, []);

  /** Ends the session's Claude (tmux window or the outside process); rejects with AgentMoveError when refused. */
  const closeWindow = useCallback(async (sessionId: string, options: { force?: boolean } = {}) => {
    const response = await api.providers.closeAgentWindow(sessionId, options.force ?? false);
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } | string };
    await refreshAgentWindows();
    if (!response.ok) {
      const error = typeof body.error === 'string' ? { message: body.error } : body.error;
      throw new AgentMoveError(error?.message ?? 'Could not close the agent', error?.code ?? null);
    }
  }, []);

  return { windows, findWindow, openWindow, closeWindow, moveToTmux, refresh: refreshAgentWindows };
}
