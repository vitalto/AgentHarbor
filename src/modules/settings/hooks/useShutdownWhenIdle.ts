import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type UnfinishedWork = 'turn' | 'background-command' | 'subagent';

/** Mirrors the power module's WatchedAgent. */
export type WatchedAgent = {
  providerSessionId: string;
  sessionId: string | null;
  title: string | null;
  cwd: string | null;
  work: UnfinishedWork;
};

/** Mirrors the server's ShutdownWhenIdleState. */
export type ShutdownWhenIdleState = {
  armed: boolean;
  armedAt: number | null;
  unfinishedAgents: WatchedAgent[];
  idleSince: number | null;
  shutdownAt: number | null;
  checkedAt: number | null;
  lastError: string | null;
  quietPeriodMs: number;
  shutdownDelaySeconds: number;
};

type ShutdownWhenIdleResponse = {
  success?: boolean;
  data?: ShutdownWhenIdleState;
  error?: { message?: string };
};

const POLL_MS = 5000;

async function readState(response: Response): Promise<ShutdownWhenIdleState> {
  const body = (await response.json()) as ShutdownWhenIdleResponse;
  if (!response.ok || !body.data) {
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }
  return body.data;
}

/** The "shut down when all agents finish" switch, polled while the page is visible. */
export function useShutdownWhenIdle() {
  const [state, setState] = useState<ShutdownWhenIdleState | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const run = useCallback(async (request: () => Promise<Response>) => {
    try {
      setState(await readState(await request()));
      setRequestError(null);
    } catch (error) {
      setRequestError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    const refreshWhileVisible = () => {
      if (document.visibilityState === 'visible') {
        void run(api.power.shutdownWhenIdle);
      }
    };
    refreshWhileVisible();
    const timer = window.setInterval(refreshWhileVisible, POLL_MS);
    document.addEventListener('visibilitychange', refreshWhileVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhileVisible);
    };
  }, [run]);

  const update = useCallback(async (request: () => Promise<Response>) => {
    setIsUpdating(true);
    await run(request);
    setIsUpdating(false);
  }, [run]);

  return {
    state,
    requestError,
    isUpdating,
    setArmed: (armed: boolean) => update(() => api.power.setShutdownWhenIdle(armed)),
    cancelShutdown: () => update(api.power.cancelShutdown),
  };
}
