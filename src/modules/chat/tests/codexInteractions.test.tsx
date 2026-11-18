import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { buildTranscriptMarkdown } from '@/modules/chat/export/buildTranscriptMarkdown';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import '@/modules/i18n';
import { api } from '@/shared/api';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

const sessionId = 'session-a';
const timestamp = '2026-11-18T18:32:00Z';
const question = 'Можете приложить обезличенный HTML?';
const call = (toolName: string, input: unknown, id = 'interaction'): NormalizedMessage => ({
  id: `call-${id}`, kind: 'tool_use', sessionId, timestamp, provider: 'codex',
  toolName, toolId: id, toolInput: input,
});
const receipt = (content: unknown, id = 'interaction'): NormalizedMessage => ({
  id: `result-${id}`, kind: 'tool_result', sessionId, timestamp, provider: 'codex',
  toolId: id, content: JSON.stringify(content),
});
const questions = [{ title: question }, { title: 'Какой формат?', options: ['HTML', 'Текст'] }];
const ask = call('request_user_input_async', JSON.stringify({ questions }));
const accepted = receipt({ accepted: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const draw = (message: ChatMessage, viewedSession = sessionId, reply = vi.fn()) => (
  <TranscriptSessionContext.Provider value={{ sessionId: viewedSession, prepareQuestionReply: reply }}>
    <MessageComponent message={message} prevMessage={null} provider="codex" createDiff={() => []} />
  </TranscriptSessionContext.Provider>
);

describe('Codex interactions in the transcript', () => {
  it('keeps the same visible questions live and on reload, without grouping separate calls or printing a receipt', () => {
    const pending = normalizedToChatMessages([ask]);
    const live = normalizedToChatMessages([ask, accepted]);
    const saved = normalizedToChatMessages([{ ...ask, toolInput: { questions }, toolResult: { content: '{"accepted":true}', isError: false } }]);
    expect(live).toHaveLength(1);
    expect(live[0].content).toBe(pending[0].content);
    expect(live[0].content).toBe(saved[0].content);
    expect(live[0].content).toContain(question);
    expect(live[0].content).toContain('HTML');
    expect(live[0].toolId).toBe(ask.toolId);
    const repeated = normalizedToChatMessages([ask, accepted, call('request_user_input_async', { questions }, 'second')]);
    expect(groupConsecutiveTools(repeated)).toHaveLength(2);
    const markdown = buildTranscriptMarkdown({ messages: saved, provider: 'codex', sessionTitle: 'Test', exportedAt: new Date(timestamp), createDiff: () => [] });
    expect(markdown).toContain(question);
    expect(markdown).not.toMatch(/request_user_input|accepted/);
  });

  it('lets the user prepare a custom reply or a suggested answer only in the originating session', () => {
    const [message] = normalizedToChatMessages([ask, accepted]);
    const reply = vi.fn();
    const view = render(draw(message, sessionId, reply));
    expect(screen.getByText(question)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/accepted|request_user_input/);
    expect(reply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    expect(reply).toHaveBeenCalledWith(questions[1], 'HTML');
    const firstQuestion = screen.getByText(question).closest('fieldset')!;
    fireEvent.click(firstQuestion.querySelector('button')!);
    expect(reply).toHaveBeenLastCalledWith({ title: question, options: [] });
    view.rerender(draw(message, 'session-b', reply));
    expect(screen.queryByRole('button', { name: 'HTML' })).toBeNull();
    expect(screen.getByText('HTML')).toBeTruthy();
  });

  it('renders a user-facing notice as an assistant message and preserves unrelated or failed calls for inspection', () => {
    const notice = call('functions.send_message_to_user_async', { message: 'Нужен файл.' });
    expect(normalizedToChatMessages([notice, accepted])).toMatchObject([{ type: 'assistant', content: 'Нужен файл.' }]);
    for (const rows of [
      [ask, receipt({ accepted: false, error: 'not delivered' })],
      [ask, { ...accepted, isError: true }],
      [ask, receipt({ extra: 'keep this output' })],
      [call('request_user_input_async', { questions: [{ missing: 'title' }] })],
      [{ ...ask, provider: 'claude' as const }],
    ]) {
      expect(normalizedToChatMessages(rows)[0].isToolUse).toBe(true);
    }
  });

  it('preserves the draft and attachment, changes a suggestion, and sends exactly once through the regular composer', async () => {
    const sendMessage = vi.fn();
    const noop = () => {};
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const attachment = { name: 'sample.html', path: '/assets/sample.html', mimeType: 'text/html' };
    vi.spyOn(api.assets, 'uploadFiles').mockResolvedValue(Response.json({ attachments: [attachment] }));
    const project = { projectId: 'proj', displayName: 'Project', fullPath: '/repo' };
    const first = { id: sessionId, __provider: 'codex' as const };
    const second = { id: 'session-b', __provider: 'codex' as const };
    const defaultMode = () => 'default' as const;
    const view = renderHook(({ session }) => useChatComposerState({
      selectedProject: project, selectedSession: session,
      currentSessionId: session.id, provider: 'codex', permissionMode: 'default', resolvePermissionModeForProvider: defaultMode,
      currentProviderModel: 'default', currentProviderEffort: 'medium', isLoading: false, canAbortSession: false, tokenBudget: null,
      sendMessage, cyclePermissionMode: noop, setPendingPermissionRequests: noop, addMessage: noop, setIsUserScrolledUp: noop, scrollToBottom: noop,
    }), { initialProps: { session: first } });
    act(() => {
      view.result.current.setInput('Черновик');
      view.result.current.setAttachedFiles([new File(['example'], attachment.name, { type: attachment.mimeType })]);
    });
    const choice = { title: 'Какой формат?', options: ['HTML', 'Текст'] };
    const prepare = view.result.current.prepareQuestionReply;
    act(() => { prepare(choice, 'Текст'); prepare(choice, 'HTML'); prepare(choice, 'HTML'); });
    expect(view.result.current.input).toBe('Черновик\n\n> Какой формат?\n\nHTML');
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => view.result.current.handleSubmit({ preventDefault: noop } as FormEvent<HTMLFormElement>));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.send', sessionId, content: 'Черновик\n\n> Какой формат?\n\nHTML', options: expect.objectContaining({ attachments: [attachment] }),
    }));
    view.rerender({ session: second });
    act(() => prepare(choice, 'HTML'));
    expect(view.result.current.input).toBe('');
  });
});
