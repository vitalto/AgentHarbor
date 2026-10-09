import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * A prompt sent from the web is typed into the Claude TUI, whose transcript
 * then streams the same user turn back live. The optimistic local row must
 * give way to it right away, not only after the next REST refresh.
 */

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionMessages: vi.fn() } },
}));

afterEach(() => {
  vi.resetModules();
});

const userRow = (id: string, timestamp: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'user',
  provider: 'claude',
  sessionId: 'session-1',
  content: 'Reply with PONG',
  timestamp,
} as NormalizedMessage);

it('drops the optimistic user row once the transcript echo of that prompt streams in', async () => {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { result } = renderHook(() => useSessionStore());

  act(() => {
    result.current.appendRealtime('session-1', userRow('local_1_abc', '2026-01-01T00:00:00.000Z'));
  });
  assert.equal(result.current.getMessages('session-1').length, 1);

  act(() => {
    result.current.appendRealtime('session-1', userRow('uuid-1_0', '2026-01-01T00:00:01.000Z'));
  });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), ['uuid-1_0']);
});
