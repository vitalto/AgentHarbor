import { memo, useEffect, useState } from 'react';
import { CpuIcon } from 'lucide-react';

import { api } from '@/shared/api';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { formatAnsweringModelLabel } from '@/modules/chat/utils/modelLabel';
import type { LLMProvider } from '@/shared/types';

type LastReply = { model: string | null; effort: string | null };

type ComposerModelButtonProps = {
  provider: LLMProvider;
  sessionId: string | null;
  /** The model choice is the catalog default, which leaves the pick to Claude. */
  followsClaudeModel: boolean;
  selectedModelLabel: string;
  selectedEffort: string;
  isLoading: boolean;
  onClick: () => void;
};

const NO_REPLY: LastReply = { model: null, effort: null };

/**
 * Rendered by chat's ChatComposer: the model and effort the next message goes
 * out with, opening the /models picker on click. A "default" choice leaves the
 * pick to Claude's own settings, so the button shows what the last reply
 * actually ran with instead of the word "default".
 */
function ComposerModelButton({
  provider,
  sessionId,
  followsClaudeModel,
  selectedModelLabel,
  selectedEffort,
  isLoading,
  onClick,
}: ComposerModelButtonProps) {
  const [loadedReply, setLoadedReply] = useState<{ sessionId: string; reply: LastReply } | null>(null);
  // A reply loaded for the previous session must not label this one while its own loads.
  const lastReply = sessionId && loadedReply?.sessionId === sessionId ? loadedReply.reply : NO_REPLY;

  // Re-read once a turn ends: that reply is the newest evidence of what ran.
  useEffect(() => {
    if (!sessionId || isLoading) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let reply = NO_REPLY;
      try {
        const response = await api.providers.sessionLastReply(provider, sessionId);
        const body = (await response.json()) as { success?: boolean; data?: LastReply };
        reply = body.success && body.data ? body.data : NO_REPLY;
      } catch {
        // The button then shows the selection alone.
      }
      if (!cancelled) {
        setLoadedReply({ sessionId, reply });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, sessionId, isLoading]);

  const followsClaudeEffort = selectedEffort === DEFAULT_EFFORT_VALUE;
  const modelText = followsClaudeModel
    ? formatAnsweringModelLabel(lastReply.model ?? undefined) ?? selectedModelLabel
    : selectedModelLabel;
  const effortText = followsClaudeEffort ? lastReply.effort : selectedEffort;
  const lastReplyText = lastReply.model
    ? `Last reply: ${lastReply.model}${lastReply.effort ? `, ${lastReply.effort} effort` : ''}.`
    : 'No reply yet.';

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="composer-model-button"
      className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      title={`Model and reasoning effort: click to change. ${lastReplyText}`}
      aria-label="Change model and reasoning effort"
    >
      <CpuIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="truncate font-medium text-foreground">{modelText}</span>
      {effortText && <span className="shrink-0">· {effortText}</span>}
    </button>
  );
}

export default memo(ComposerModelButton);
