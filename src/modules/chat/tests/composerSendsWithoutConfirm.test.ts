import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { api } from '@/shared/api';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A message is typed into the session's own Claude window, which keeps its
 * background work running across turns: the composer sends without asking.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

function renderComposer(provider: 'codex' | 'claude', sendByCtrlEnter = false) {
  const sent: Array<{ type: string; content?: string; options?: { attachments: unknown[] } }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider,
      sendByCtrlEnter,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  return { sent, view };
}

const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('confirm', confirm);
  confirm.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('sending never asks for confirmation, whatever runs in the background', async () => {
  const { sent, view } = renderComposer('claude');
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 1);
});

test.each([false, true])('the configured send key preserves newlines and four PNGs (Ctrl+Enter %s)', async (sendByCtrlEnter) => {
  const { sent, view } = renderComposer('codex', sendByCtrlEnter);
  const files = [1, 2, 3, 4].map((n) => new File(['png'], `${n}.png`, { type: 'image/png' }));
  const attachments = files.map((file) => ({ name: file.name, path: '/uploads/' + file.name, mimeType: file.type }));
  const upload = vi.spyOn(api.assets, 'uploadFiles').mockImplementation(async (form) => {
    assert.deepEqual(form.getAll('files').map((file) => (file as File).name), files.map((file) => file.name));
    return new Response(JSON.stringify({ attachments }));
  });
  const enter = async (shiftKey: boolean, ctrlKey: boolean) => {
    const preventDefault = vi.fn();
    await act(async () => view.result.current.handleKeyDown({
      key: 'Enter', nativeEvent: {}, shiftKey, ctrlKey, preventDefault,
    } as unknown as KeyboardEvent<HTMLTextAreaElement>));
    return preventDefault.mock.calls.length > 0;
  };
  const paragraph = 'Первая строка\n'.repeat(30);
  await act(async () => {
    view.result.current.setInput(paragraph);
    view.result.current.setAttachedFiles(files);
  });
  assert.equal(await enter(true, false), false);
  if (sendByCtrlEnter) assert.equal(await enter(false, false), false);
  assert.equal(upload.mock.calls.length, 0);
  assert.equal(sent.length, 0);
  const content = paragraph + '\nПоследняя строка';
  await act(async () => view.result.current.setInput(content));
  assert.equal(await enter(false, sendByCtrlEnter), true);
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].type, 'chat.send');
  assert.equal(sent[0].content, content);
  assert.deepEqual(sent[0].options?.attachments, attachments);
});
