import { act, renderHook, waitFor } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import '@/modules/i18n';
import { api } from '@/shared/api';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const project: Project = { projectId: 'project', displayName: 'Project', fullPath: '/repo' };
const first: ProjectSession = { id: 'first', __provider: 'codex' };
const second: ProjectSession = { id: 'second', __provider: 'codex' };
const noop = () => {};

it('only retires the addressed preview, including across tabs, repeated text and reconnects', () => {
  const { result } = renderHook(() => useSessionStore());
  const row = (id: string, content: string): NormalizedMessage => ({
    id, content, timestamp: '2026-11-18T20:57:00Z', sessionId: first.id, provider: 'codex', kind: 'text', role: 'user',
  });
  act(() => {
    for (const id of ['a', 'b']) result.current.appendRealtime(first.id, row('local_send_' + id, '☒?'));
    result.current.appendRealtime(second.id, row('local_send_a', 'другая вкладка'));
    result.current.appendRealtime(first.id, row('terminal', '☒?'));
    result.current.acknowledgeInput(first.id, 'a');
    result.current.appendRealtime(first.id, row('first-delivered', 'другое отображение'));
    result.current.acknowledgeInput(first.id, 'a');
  });
  expect(result.current.getMessages(first.id).map(item => item.id)).toEqual(['local_send_b', 'terminal', 'first-delivered']);
  expect(result.current.getMessages(second.id)).toHaveLength(1);
  act(() => result.current.discardDisconnectedInputs(['b']));
  expect(result.current.getMessages(second.id)).toHaveLength(0);
  expect(result.current.getMessages(first.id)).toHaveLength(3);
  act(() => result.current.acknowledgeInput(first.id, 'b'));
  expect(result.current.getMessages(first.id).map(item => item.id)).toEqual(['terminal', 'first-delivered']);
});

it.each([
  { name: 'photo.png', mime: 'image/png', kind: 'images', prompt: 'Here is the photo', inline: false },
  { name: 'photo.png', mime: 'image/png', kind: 'images', prompt: '', inline: true },
  { name: 'notes.txt', mime: 'text/plain', kind: 'files', prompt: '', inline: false },
  { name: 'drawing.svg', mime: 'image/svg+xml', kind: 'files', prompt: 'Here is the drawing', inline: false },
  { name: 'данные.txt', mime: 'text/plain', kind: 'files', prompt: '[цитата] > ВЭМ ☒?', inline: false },
] as const)('keeps each send of $name once during live delivery, history refresh and dialog switches ($prompt)', async ({ name, mime, kind, prompt, inline }) => {
  const history: NormalizedMessage[] = [];
  const sendMessage = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  vi.spyOn(api.providers, 'sessionMessages').mockImplementation(async (sessionId) =>
    Response.json({ data: { messages: sessionId === first.id ? history : [], hasMore: false } }));
  let uploadCount = 0;
  vi.spyOn(api.assets, 'uploadFiles').mockImplementation(async () => {
    uploadCount++;
    return Response.json({ attachments: [{ path: `/uploads/${uploadCount}-${name}`, name, mimeType: mime }] });
  });
  const scrollRefs = { statusCheckSentAtRef: { current: new Map<string, number>() }, lastSeqRef: { current: new Map<string, number>() } };
  const view = renderHook(({ selectedSession }) => {
    const store = useSessionStore();
    const chat = useChatSessionState({
      selectedProject: project, selectedSession, isActive: true, ws: null, sessionStore: store,
      sendMessage: noop, resetStreamingState: noop, ...scrollRefs,
    });
    const composer = useChatComposerState({
      selectedProject: project, selectedSession, currentSessionId: chat.currentSessionId, provider: 'codex',
      permissionMode: 'default', resolvePermissionModeForProvider: () => 'default', cyclePermissionMode: noop,
      currentProviderModel: 'default', currentProviderEffort: 'medium', isLoading: false, canAbortSession: false,
      tokenBudget: null, sendMessage, setPendingPermissionRequests: noop, addMessage: chat.addMessage,
      setIsUserScrolledUp: chat.setIsUserScrolledUp, scrollToBottom: chat.scrollToBottom,
    });
    return { composer, rows: chat.visibleMessages, store, loading: chat.isLoadingSessionMessages };
  }, { initialProps: { selectedSession: first } });
  await waitFor(() => expect(view.result.current.loading).toBe(false));

  const userRows = () => view.result.current.rows.map((row) => [row.content, row[kind]?.[0]]);
  const send = async () => {
    act(() => {
      view.result.current.composer.setInput(prompt);
      view.result.current.composer.setAttachedFiles([new File(['example'], name, { type: mime })]);
    });
    await act(async () => view.result.current.composer.handleSubmit({ preventDefault: noop } as FormEvent<HTMLFormElement>));
  };
  const echo = (number: number): NormalizedMessage => ({
    id: `codex-user-${number}`, sessionId: first.id, timestamp: new Date().toISOString(),
    kind: 'text', role: 'user', provider: 'codex', content: prompt,
    [kind]: [inline ? { data: 'data:image/png;base64,QQ==' } : { path: `C:/staging/${number}-${name}`, name }],
  });
  const deliver = (row: NormalizedMessage, sendIndex: number) => act(() => {
    const { clientMessageId } = sendMessage.mock.calls[sendIndex][0];
    expect(clientMessageId).toMatch(/^[a-f0-9]{32}$/);
    view.result.current.store.acknowledgeInput(first.id, clientMessageId);
    view.result.current.store.appendRealtime(first.id, row);
  });
  const select = (selectedSession: ProjectSession) => act(async () => view.rerender({ selectedSession }));

  await send();
  expect(sendMessage.mock.calls.map(([frame]) => [frame.type, frame.sessionId, frame.content])).toEqual([['chat.send', first.id, prompt]]);
  expect(userRows()).toEqual([[prompt, { name, path: `/uploads/1-${name}`, mimeType: mime }]]);
  const firstEcho = echo(1);
  if (prompt.includes('☒')) firstEcho.content = 'цитата ВЭМ';
  deliver(firstEcho, 0);
  expect(userRows()).toEqual([[firstEcho.content, firstEcho[kind]?.[0]]]);
  history.push(firstEcho);
  await select(second);
  expect(userRows()).toEqual([]);
  await select(first);

  await send();
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(userRows()).toEqual([
    [firstEcho.content, firstEcho[kind]?.[0]], [prompt, { name, path: `/uploads/2-${name}`, mimeType: mime }],
  ]);
  const secondEcho = echo(2);
  expect(sendMessage.mock.calls[0][0].clientMessageId).not.toBe(sendMessage.mock.calls[1][0].clientMessageId);
  deliver(secondEcho, 1);
  history.push(secondEcho);
  await select(second);
  await select(first);
  expect(userRows()).toEqual([[firstEcho.content, firstEcho[kind]?.[0]], [prompt, secondEcho[kind]?.[0]]]);
});
