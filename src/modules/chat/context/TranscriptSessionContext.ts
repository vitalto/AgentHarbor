import { createContext, useContext } from 'react';

import type { AgentQuestion } from '@/shared/types';

/**
 * ChatInterface scopes transcript actions to the open session. Workflow cards
 * fetch that session's timeline, and question cards prepare replies in its composer.
 * A bare render or exported document has no active session.
 */
export const TranscriptSessionContext = createContext<{
  sessionId: string | null;
  /** Available when this transcript has a composer that can accept a new follow-up. */
  prepareQuestionReply?: (question: AgentQuestion, answer?: string) => void;
}>({ sessionId: null });

/** The app session id the transcript belongs to, or null outside a session. */
export function useTranscriptSessionId(): string | null {
  return useContext(TranscriptSessionContext).sessionId;
}
