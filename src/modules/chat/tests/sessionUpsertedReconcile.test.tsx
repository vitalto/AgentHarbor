import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * The open conversation learns of transcript rows only through the live tail,
 * which a resubscribe restarts at end-of-file. A `session_upserted` for the
 * visible session is the file-watcher's authoritative "the transcript changed"
 * signal, so the handler reconciles against it to recover rows the tail gap
 * dropped — but only when no response is streaming, so it never fights the
 * live stream.
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const syncs: string[] = [];
  const activityBySession = new Map<string, SessionActivity>();

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    getSessionActivity: (sessionId) => activityBySession.get(sessionId),
    requestLatestMessages: async (sessionId) => { syncs.push(sessionId); },
    sessionStore: {
      appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  const markResponseInFlight = (sessionId: string) => {
    activityBySession.set(sessionId, { statusText: null, canInterrupt: true, startedAt: 0 });
  };
  const markBackgroundOnly = (sessionId: string) => {
    activityBySession.set(sessionId, { statusText: null, canInterrupt: false, startedAt: 0, background: true });
  };
  return { dispatch, syncs, markResponseInFlight, markBackgroundOnly };
};

const upserted = (sessionId: string): ServerEvent => ({
  id: `event-${Math.random()}`,
  kind: 'session_upserted',
  sessionId,
  provider: 'claude',
  timestamp: '2026-08-21T10:32:10.000Z',
} as unknown as ServerEvent);

test('session_upserted reconciles the visible session when idle', () => {
  const { dispatch, syncs } = renderHandlers();
  dispatch(upserted('viewed-session'));
  assert.deepEqual(syncs, ['viewed-session']);
});

test('session_upserted reconciles the visible session when only background work runs', () => {
  const { dispatch, syncs, markBackgroundOnly } = renderHandlers();
  markBackgroundOnly('viewed-session');
  dispatch(upserted('viewed-session'));
  assert.deepEqual(syncs, ['viewed-session']);
});

test('session_upserted does not reconcile while a response is streaming', () => {
  const { dispatch, syncs, markResponseInFlight } = renderHandlers();
  markResponseInFlight('viewed-session');
  dispatch(upserted('viewed-session'));
  assert.deepEqual(syncs, []);
});

test('session_upserted for another session never reconciles the visible one', () => {
  const { dispatch, syncs } = renderHandlers();
  dispatch(upserted('other-session'));
  assert.deepEqual(syncs, []);
});
