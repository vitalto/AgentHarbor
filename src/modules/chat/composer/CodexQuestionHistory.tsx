import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { AgentQuestionCard } from '@/modules/chat/transcript/AgentQuestionCard';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/** ChatInterface keeps past questions accessible without paging through intervening commands. */
export function CodexQuestionHistory({ sessionId, saved, live }: {
  sessionId: string;
  saved?: NormalizedMessage[];
  live: ChatMessage[];
}) {
  const { t } = useTranslation('chat');
  const history = useMemo(() => {
    const calls = new Map<string, ChatMessage>();
    for (const row of [...normalizedToChatMessages(saved ?? []), ...live]) {
      if (row.questionRequest?.sessionId === sessionId && row.toolId) calls.set(row.toolId, row);
    }
    return [...calls.values()].reverse();
  }, [live, saved, sessionId]);
  if (!history.length) return null;
  const count = history.reduce((total, row) => total + row.questionRequest!.questions.length, 0);
  return (
    <details className="mx-auto max-w-[54.25rem] px-2 text-sm">
      <summary className="cursor-pointer rounded-md px-1 py-1.5 text-primary">{t('interaction.history', { count })}</summary>
      <div className="max-h-[35dvh] space-y-2 overflow-y-auto overscroll-contain pb-2">
        {history.map((row) => <AgentQuestionCard key={row.toolId} request={row.questionRequest!} />)}
      </div>
    </details>
  );
}
