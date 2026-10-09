import { useState } from 'react';
import { Eraser } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useAgentWindows, type AgentWindow } from '@/shared/hooks/useAgentWindows';

type ClearConversationButtonProps = {
  agent: AgentWindow;
};

/**
 * `/clear` for the session's Claude window: the same process starts a fresh
 * conversation (the old one stays in history) and the chat moves to it.
 */
export default function ClearConversationButton({ agent }: ClearConversationButtonProps) {
  const { clearConversation } = useAgentWindows();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'idle' | 'clearing'>('idle');
  const [error, setError] = useState<string | null>(null);

  const clear = async () => {
    setPhase('clearing');
    setError(null);
    try {
      const newSessionId = await clearConversation(agent.sessionId);
      setPhase('idle');
      navigate(`/session/${newSessionId}`);
    } catch (clearError) {
      setPhase('idle');
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    }
  };

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="Clear: start a new conversation in this Claude window"
        title="Clear (/clear): start a new conversation in this window; this one stays in history"
        disabled={phase === 'clearing'}
        onClick={() => void clear()}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:animate-pulse disabled:opacity-50"
      >
        <Eraser className="h-3.5 w-3.5" />
      </button>
      {error && (
        <button
          type="button"
          onClick={() => setError(null)}
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-red-500/30 bg-background p-2 text-left text-[11px] text-foreground shadow-lg"
        >
          {error}
        </button>
      )}
    </span>
  );
}
