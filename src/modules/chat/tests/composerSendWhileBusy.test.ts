import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A session living in a tmux window takes typed input while Claude works (the
 * TUI reads it once the current step ends), so a message sent mid-turn goes
 * out at once instead of waiting in the composer's queue.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const submitWhileBusy = async (sendWhileBusy: boolean) => {
  const sent: Array<{ type: string; content?: string }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      sendWhileBusy,
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: true,
      processingSessions: new Map(),
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string; content?: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  await act(async () => { view.result.current.setInput('also check the tests'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  return { sends: sent.filter((message) => message.type === 'chat.send'), view };
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a live tmux session gets a mid-turn message right away', async () => {
  const { sends, view } = await submitWhileBusy(true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].content, 'also check the tests');
  assert.equal(view.result.current.queuedDraft, null);
});

test('without a live window the mid-turn message is queued as before', async () => {
  const { sends, view } = await submitWhileBusy(false);
  assert.equal(sends.length, 0);
  assert.equal(view.result.current.queuedDraft?.content, 'also check the tests');
});
