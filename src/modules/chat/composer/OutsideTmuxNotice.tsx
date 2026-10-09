import { useState } from 'react';

import { AgentMoveError, type AgentWindow } from '@/shared/hooks/useAgentWindows';

type OutsideTmuxNoticeProps = {
  agent: AgentWindow;
  /** The user tried to send: offer to move and send the waiting message in one go. */
  hasPendingMessage: boolean;
  onMove: (options: { force?: boolean }) => Promise<void>;
  onMoveAndSend: (options: { force?: boolean }) => Promise<void>;
};

/**
 * Shown above the composer when the viewed session's Claude runs in another
 * terminal (or twice). Moving ends that process — the server only does it while
 * Claude is idle there — and continues the session in tmux, where the chat can
 * drive it.
 */
export default function OutsideTmuxNotice({ agent, hasPendingMessage, onMove, onMoveAndSend }: OutsideTmuxNoticeProps) {
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  /** The last move was refused because Claude there is busy; the user may override. */
  const [canForce, setCanForce] = useState(false);
  const where = agent.location === 'windows' ? 'a Windows terminal' : 'another terminal';

  const run = async (action: (options: { force?: boolean }) => Promise<void>, force = false) => {
    setIsMoving(true);
    setMoveError(null);
    setCanForce(false);
    try {
      await action({ force });
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
      setCanForce(error instanceof AgentMoveError && error.code === 'AGENT_BUSY_ELSEWHERE');
    } finally {
      setIsMoving(false);
    }
  };

  const message = agent.duplicateProcesses
    ? 'Two Claude processes hold this session, so both write its history. Close the copy outside tmux to keep only this one.'
    : hasPendingMessage
      ? `This session runs in ${where} (pid ${agent.pid}). Move it to tmux to send your message from here? Claude there is closed first, only if it is idle.`
      : `This session runs in ${where} (pid ${agent.pid}). You can watch it here; to chat from here, move it to tmux.`;

  return (
    <div
      className="mx-auto mb-2 flex max-w-[54.25rem] flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      data-testid="outside-tmux-notice"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {moveError && <span className="basis-full text-red-600 dark:text-red-400">{moveError}</span>}
      <div className="flex shrink-0 gap-2">
        {canForce && (
          <button
            type="button"
            disabled={isMoving}
            onClick={() => void run(hasPendingMessage && !agent.duplicateProcesses ? onMoveAndSend : onMove, true)}
            className="rounded-md bg-red-600 px-2.5 py-1 font-medium text-white disabled:opacity-50"
          >
            Close it anyway
          </button>
        )}
        {hasPendingMessage && !agent.duplicateProcesses && (
          <button
            type="button"
            disabled={isMoving}
            onClick={() => void run(onMoveAndSend)}
            className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-50"
          >
            Move to tmux and send
          </button>
        )}
        <button
          type="button"
          disabled={isMoving}
          onClick={() => void run(onMove)}
          className="rounded-md border border-border bg-background px-2.5 py-1 font-medium disabled:opacity-50"
        >
          {isMoving ? 'Moving…' : agent.duplicateProcesses ? 'Close the other copy' : 'Move to tmux'}
        </button>
      </div>
    </div>
  );
}
