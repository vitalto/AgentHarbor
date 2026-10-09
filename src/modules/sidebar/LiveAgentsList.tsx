import { useState } from 'react';
import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { AgentMoveError, useAgentWindows, type AgentWindow } from '@/shared/hooks/useAgentWindows';
import AgentWindowBadge, { describeAgentActivity, describeAgentLocation } from '@/modules/sidebar/AgentWindowBadge';

function projectLabel(projectPath: string | null): string {
  if (!projectPath) {
    return '';
  }
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

const agentKey = (agent: AgentWindow) => `${agent.location}-${agent.providerSessionId}-${agent.windowName ?? agent.pid}`;

type CloseState = { key: string; phase: 'confirm' | 'closing' | 'busy'; message?: string };

/** Every Claude agent running right now, wherever it runs: one click opens its chat, the × ends it. */
export default function LiveAgentsList() {
  const { windows, closeWindow } = useAgentWindows();
  const navigate = useNavigate();
  const [closeState, setCloseState] = useState<CloseState | null>(null);

  if (windows.length === 0) {
    return null;
  }

  const close = async (agent: AgentWindow, force: boolean) => {
    const key = agentKey(agent);
    setCloseState({ key, phase: 'closing' });
    try {
      await closeWindow(agent.sessionId, { force });
      setCloseState(null);
    } catch (error) {
      if (error instanceof AgentMoveError && error.code === 'AGENT_BUSY_ELSEWHERE') {
        setCloseState({ key, phase: 'busy', message: error.message });
      } else {
        setCloseState(null);
        console.error('[AgentHarbor] closing the agent failed', error);
      }
    }
  };

  return (
    <section className="mb-2 border-b border-border/50 pb-2" aria-label="Live agents" data-testid="live-agents">
      <h3 className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Live agents · {windows.length}
      </h3>
      <ul className="space-y-0.5">
        {windows.map((agent) => {
          const key = agentKey(agent);
          const rowState = closeState?.key === key ? closeState : null;
          return (
            <li key={key} className="group">
              <div className="flex items-center rounded-md hover:bg-accent">
                <button
                  type="button"
                  onClick={() => navigate(`/session/${agent.sessionId}`)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
                  title={`${describeAgentLocation(agent)} · ${describeAgentActivity(agent)}`}
                >
                  <AgentWindowBadge provider="claude" agentWindow={agent} className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{agent.title || agent.windowName || 'Claude session'}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {projectLabel(agent.projectPath)}
                      {agent.location !== 'tmux' ? ' · outside tmux' : ''}
                      {' · '}
                      {describeAgentActivity(agent)}
                    </span>
                  </span>
                </button>
                {rowState?.phase === 'confirm' ? (
                  <button
                    type="button"
                    onClick={() => void close(agent, false)}
                    className="mr-1 shrink-0 rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white"
                  >
                    Close?
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Close Claude for ${agent.title || agent.windowName || 'this session'}`}
                    title="Close this Claude (the conversation stays)"
                    disabled={rowState?.phase === 'closing'}
                    onClick={() => setCloseState({ key, phase: 'confirm' })}
                    className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-60 hover:bg-background hover:text-foreground hover:opacity-100 disabled:opacity-30 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {rowState?.phase === 'busy' && (
                <div className="mx-3 mb-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-foreground">
                  {rowState.message}
                  <div className="mt-1 flex gap-2">
                    <button type="button" onClick={() => void close(agent, true)} className="rounded bg-red-600 px-2 py-0.5 font-medium text-white">
                      Close anyway
                    </button>
                    <button type="button" onClick={() => setCloseState(null)} className="rounded border border-border px-2 py-0.5">
                      Keep
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
