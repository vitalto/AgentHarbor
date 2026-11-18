import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { api } from '@/shared/api';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionMessages: vi.fn(), sessionTokenUsage: async () => ({ ok: false }) } },
}));

const project: Project = { projectId: 'project', displayName: 'Project', fullPath: '/repo' };
const first: ProjectSession = { id: 'first', __provider: 'codex' };
const second: ProjectSession = { id: 'second', __provider: 'codex' };
const prompt: NormalizedMessage = {
  id: 'prompt', sessionId: first.id, provider: 'codex', kind: 'text', role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z', content: 'First dialog',
};

async function openDialogs(firstPage: NormalizedMessage[]) {
  const history = new Map([
    [first.id, firstPage],
    [second.id, [{ ...prompt, sessionId: second.id, content: 'Second dialog' }]],
  ]);
  vi.mocked(api.providers.sessionMessages).mockImplementation(async (sessionId) => {
    const messages = history.get(sessionId) ?? [];
    return Response.json({ data: { messages, total: messages.length, hasMore: false } });
  });

  const options = {
    isActive: true, selectedProject: project, ws: null, sendMessage: vi.fn(), resetStreamingState: vi.fn(),
    statusCheckSentAtRef: { current: new Map<string, number>() }, lastSeqRef: { current: new Map<string, number>() },
  };
  const view = renderHook(({ selectedSession }) => {
    const store = useSessionStore();
    const state = useChatSessionState({ ...options, selectedSession, sessionStore: store });
    return { store, state };
  }, { initialProps: { selectedSession: first } });
  const visible = () => view.result.current.state.visibleMessages.map((message) => message.content);
  const append = (message: NormalizedMessage) => {
    act(() => view.result.current.store.appendRealtime(message.sessionId, message));
  };
  const select = async (selectedSession: ProjectSession) => {
    await act(async () => view.rerender({ selectedSession }));
  };
  await waitFor(() => expect(visible()).toContain('First dialog'));
  return { append, history, select, visible };
}

it('shows a replayed Codex row once when returning to a dialog before history catches up', async () => {
  const { append, history, select, visible } = await openDialogs([prompt]);
  const thinking: NormalizedMessage = {
    id: 'thinking-1', sessionId: first.id, provider: 'codex', kind: 'thinking',
    timestamp: '2026-01-01T00:00:01.000Z', content: 'Checking',
  };
  append({ ...thinking, seq: 4 });
  await select(second);
  expect(visible()).toEqual(['Second dialog']);

  await select(first);
  append({ ...thinking, seq: 4 });
  const next = { ...thinking, id: 'thinking-2' };
  append({ ...next, seq: 5 });
  expect(visible()).toEqual(['First dialog', 'Checking', 'Checking']);

  history.set(first.id, [prompt, thinking, next]);
  await select(second);
  await select(first);
  expect(visible()).toEqual(['First dialog', 'Checking', 'Checking']);
});

it('keeps distinct Codex replies with identical text while reopening and after persistence', async () => {
  const reply: NormalizedMessage = {
    id: 'text_1', sessionId: first.id, provider: 'codex', kind: 'text', role: 'assistant',
    timestamp: '2026-01-01T00:00:01.000Z', content: 'Done',
  };
  const { append, history, select, visible } = await openDialogs([prompt, reply]);
  const next = { ...reply, id: 'text_2' };
  append(next);
  await select(second);
  await select(first);
  expect(visible()).toEqual(['First dialog', 'Done', 'Done']);

  history.set(first.id, [prompt, reply, next]);
  await select(second);
  await select(first);
  expect(visible()).toEqual(['First dialog', 'Done', 'Done']);
});

it('replaces a finalized local stream with its transcript reply before the next identical reply arrives', () => {
  const { result } = renderHook(useSessionStore);
  const reply: NormalizedMessage = { ...prompt, id: 'reply-1', role: 'assistant', content: 'Done' };
  act(() => {
    result.current.updateStreaming(first.id, 'Done', 'codex');
    result.current.finalizeStreaming(first.id);
    result.current.appendRealtime(first.id, reply);
    result.current.appendRealtime(first.id, { ...reply, id: 'reply-2' });
  });
  expect(result.current.getMessages(first.id).map((row) => row.id)).toEqual(['reply-1', 'reply-2']);
});
