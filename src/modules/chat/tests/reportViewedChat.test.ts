import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useReportViewedChat } from '@/modules/chat/hooks/useReportViewedChat';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('the page reports the chat it shows, hides it when the tab is hidden, and clears it when the chat closes', () => {
  vi.useFakeTimers();
  setVisibility('visible');
  const sent: unknown[] = [];
  const sendMessage = (message: unknown) => sent.push(message);
  const { rerender, unmount } = renderHook((props: { viewedSessionId: string | null; isActive: boolean }) => useReportViewedChat({
    sendMessage, isConnected: true, ...props,
  }), { initialProps: { viewedSessionId: 'chat-a', isActive: true } });

  assert.deepEqual(sent.at(-1), { type: 'chat.viewing', sessionId: 'chat-a', visible: true });
  setVisibility('hidden');
  assert.deepEqual(sent.at(-1), { type: 'chat.viewing', sessionId: 'chat-a', visible: false });
  setVisibility('visible');

  const reportsBefore = sent.length;
  vi.advanceTimersByTime(30_000);
  assert.equal(sent.length, reportsBefore + 1, 'repeated while it lasts');

  rerender({ viewedSessionId: 'chat-a', isActive: false });
  assert.deepEqual(sent.at(-1), { type: 'chat.viewing', sessionId: 'chat-a', visible: false }, 'the files or shell tab is in front');

  unmount();
  assert.deepEqual(sent.at(-1), { type: 'chat.viewing', sessionId: null, visible: false });
  vi.useRealTimers();
});

test('nothing is reported while the socket is down', () => {
  const sent: unknown[] = [];
  renderHook(() => useReportViewedChat({ sendMessage: (message) => sent.push(message), viewedSessionId: 'chat-a', isActive: true, isConnected: false }));
  assert.deepEqual(sent, []);
});
