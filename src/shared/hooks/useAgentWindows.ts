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

  const closeWindow = useCallback(async (sessionId: string) => {
    await api.providers.closeAgentWindow(sessionId);
    await refreshAgentWindows();
  }, []);

  return { windows, findWindow, openWindow, closeWindow, refresh: refreshAgentWindows };
}
