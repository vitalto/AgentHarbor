import { useContext } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import type { AgentQuestionRequest } from '@/shared/types';

/** The chat transcript uses this card to prepare a reply to an asynchronous question in the current composer. */
export function AgentQuestionCard({ request }: { request: AgentQuestionRequest }) {
  const { t } = useTranslation('chat');
  const { sessionId, prepareQuestionReply } = useContext(TranscriptSessionContext);
  const exporting = useIsExportingTranscript();
  const reply = !exporting && sessionId && sessionId === request.sessionId ? prepareQuestionReply : undefined;

  return (
    <div className="space-y-3">
      {request.questions.map((question, index) => (
        <fieldset key={index} className="min-w-0 rounded-xl border border-border bg-card px-3 pb-3">
          <legend dir="auto" className="max-w-full whitespace-pre-wrap break-words px-1 text-sm font-medium text-foreground">
            {question.title}
          </legend>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {question.options.map((option) => reply ? (
              <button
                key={option}
                type="button"
                className="max-w-full whitespace-pre-wrap break-words rounded-lg border border-border px-3 py-2 text-start text-sm hover:bg-accent focus-visible:outline-primary"
                onClick={() => reply(question, option)}
              >
                {option}
              </button>
            ) : (
              <span key={option} className="max-w-full whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-1.5 text-sm">{option}</span>
            ))}
            {reply && (
              <button
                type="button"
                className="rounded-lg px-2 py-2 text-sm font-medium text-primary hover:underline focus-visible:outline-primary"
                onClick={() => reply(question)}
              >
                {t(question.options.length ? 'interaction.customReply' : 'interaction.reply')}
              </button>
            )}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
