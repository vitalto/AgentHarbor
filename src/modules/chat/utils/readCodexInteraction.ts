import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';
import type { AgentQuestionRequest, ChatMessage, NormalizedMessage, ToolResult } from '@/shared/types';

function isDeliveryReceipt(result: ToolResult): boolean {
  const data = parseToolPayload(result.content);
  return !result.isError && typeof data === 'object' && data !== null
    && Object.keys(data).length === 1 && 'accepted' in data && data.accepted === true;
}

/** Turns Codex's user-facing async calls into the same chat rows for live delivery and saved history. */
export function readCodexInteraction(message: NormalizedMessage, result: ToolResult | null): Pick<ChatMessage, 'content' | 'questionRequest'> | null {
  if (message.provider !== 'codex') return null;
  const name = message.toolName?.replace(/^functions\./, '');
  if (name !== 'request_user_input_async' && name !== 'send_message_to_user_async') return null;
  // Unknown output can carry an error or new provider data. Leave it in the ordinary tool view.
  if (result && !isDeliveryReceipt(result)) return null;

  const input = parseToolPayload(message.toolInput);
  if (!input || typeof input !== 'object') return null;
  if (name === 'send_message_to_user_async') {
    return 'message' in input && typeof input.message === 'string' && input.message.trim()
      ? { content: input.message } : null;
  }

  if (!('questions' in input) || !Array.isArray(input.questions) || !input.questions.length) return null;
  const questions: AgentQuestionRequest['questions'] = [];
  for (const entry of input.questions) {
    if (typeof entry?.title !== 'string' || !entry.title.trim()) return null;
    const options: unknown = entry.options ?? [];
    if (!Array.isArray(options) || !options.every((label): label is string => typeof label === 'string' && !!label.trim())) return null;
    questions.push({ title: entry.title.trim(), options: [...new Set(options.map(label => label.trim()))] });
  }

  return {
    content: questions.map(({ title, options }) => [title, ...options.map(label => '- ' + label)].join('\n')).join('\n\n'),
    questionRequest: { sessionId: message.sessionId, questions },
  };
}
