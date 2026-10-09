import { useState } from 'react';
import { Power, X } from 'lucide-react';

import { AgentMoveError, useAgentWindows, type AgentWindow } from '@/shared/hooks/useAgentWindows';
import { cn } from '@/shared/utils';

type CloseAgentButtonProps = {
  agent: AgentWindow;
  /** `x` in lists, `power` in the chat header. */
  icon?: 'x' | 'power';
  className?: string;
};

type Phase = 'idle' | 'confirm' | 'closing' | 'busy';

/**
 * Ends the session's Claude (its tmux window, or the process in another
 * terminal); the conversation stays and can be resumed. The first click asks;
 * a copy busy outside tmux needs an explicit "Close anyway".
 */
export default function CloseAgentButton({ agent, icon = 'x', className }: CloseAgentButtonProps) {
  const { closeWindow } = useAgentWindows();
  const [phase, setPhase] = useState<Phase>('idle');
  const [busyMessage, setBusyMessage] = useState('');
  const label = agent.title || agent.windowName || 'this session';

  const close = async (force: boolean) => {
    setPhase('closing');
    try {
      await closeWindow(agent.sessionId, { force });
      setPhase('idle');
    } catch (error) {
      if (error instanceof AgentMoveError && error.code === 'AGENT_BUSY_ELSEWHERE') {
        setBusyMessage(error.message);
        setPhase('busy');
        return;
      }
      setPhase('idle');
      console.error('[AgentHarbor] closing the agent failed', error);
    }
  };

  const Icon = icon === 'power' ? Power : X;

  return (
    <span className="relative inline-flex shrink-0">
      {phase === 'confirm' ? (
        <button
          type="button"
          onClick={() => void close(false)}
          onBlur={() => setPhase('idle')}
          autoFocus
          className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white"
        >
          Close?
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Close Claude for ${label}`}
          title="Close this Claude (the conversation stays)"
          disabled={phase === 'closing'}
          onClick={() => setPhase('confirm')}
          className={cn('rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30', className)}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      )}
      {phase === 'busy' && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-red-500/30 bg-background p-2 text-[11px] text-foreground shadow-lg">
          {busyMessage}
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={() => void close(true)} className="rounded bg-red-600 px-2 py-0.5 font-medium text-white">
              Close anyway
            </button>
            <button type="button" onClick={() => setPhase('idle')} className="rounded border border-border px-2 py-0.5">
              Keep
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
