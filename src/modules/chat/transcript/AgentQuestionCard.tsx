import { PencilLine } from 'lucide-react';
import { useContext, useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import type { AgentQuestionRequest } from '@/shared/types';

/** The chat transcript uses this card to prepare a reply to an asynchronous question in the current composer. */
export function AgentQuestionCard({ request }: { request: AgentQuestionRequest }) {
  const { t } = useTranslation('chat');
  const questionId = useId();
  const { sessionId, prepareQuestionReply } = useContext(TranscriptSessionContext);
  const exporting = useIsExportingTranscript();
  const reply = !exporting && sessionId && sessionId === request.sessionId ? prepareQuestionReply : undefined;

  return (
    <div className="space-y-3">
      {request.questions.map((question, index) => (
        <fieldset key={index} aria-labelledby={`${questionId}-${index}`} className="min-w-0 rounded-xl border border-border bg-card p-0 text-card-foreground">
          <p id={`${questionId}-${index}`} dir="auto" className="whitespace-pre-wrap px-4 py-3 text-[15px] leading-6 [overflow-wrap:anywhere]">
            {question.title}
          </p>
          {(question.options.length > 0 || reply) && (
            <div className="flex flex-col gap-2 rounded-b-xl border-t border-border bg-muted/30 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
              {question.options.map((option) => reply ? (
                <button
                  key={option}
                  type="button"
                  dir="auto"
                  className="min-h-10 max-w-full whitespace-pre-wrap rounded-lg border border-border bg-card px-3 py-2 text-start text-sm leading-5 [overflow-wrap:anywhere] hover:border-primary/50 hover:bg-accent focus-visible:outline-primary"
                  onClick={() => reply(question, option)}
                >
                  {option}
                </button>
              ) : (
                <span key={option} dir="auto" className="max-w-full whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm [overflow-wrap:anywhere]">{option}</span>
              ))}
              {reply && (
                <button
                  type="button"
                  className="inline-flex min-h-10 items-center gap-2 self-start rounded-lg px-2 py-2 text-start text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-primary"
                  onClick={() => reply(question)}
                >
                  <PencilLine aria-hidden="true" className="size-4 shrink-0" />
                  {t(question.options.length ? 'interaction.customReply' : 'interaction.reply')}
                </button>
              )}
            </div>
          )}
        </fieldset>
      ))}
    </div>
  );
}
