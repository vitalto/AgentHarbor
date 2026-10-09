import { useNavigate } from 'react-router-dom';

import { useAgentWindows, type AgentWindow } from '@/shared/hooks/useAgentWindows';
import AgentWindowBadge, { describeAgentActivity, describeAgentLocation } from '@/modules/live-agents/AgentWindowBadge';
import CloseAgentButton from '@/modules/live-agents/CloseAgentButton';

function projectLabel(projectPath: string | null): string {
  if (!projectPath) {
    return '';
  }
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

const agentKey = (agent: AgentWindow) => `${agent.location}-${agent.providerSessionId}-${agent.windowName ?? agent.pid}`;

/** Every Claude agent running right now, wherever it runs: one click opens its chat, the × ends it. */
export default function LiveAgentsList() {
  const { windows } = useAgentWindows();
  const navigate = useNavigate();

  if (windows.length === 0) {
    return null;
  }

  return (
    <section className="mb-2 border-b border-border/50 pb-2" aria-label="Live agents" data-testid="live-agents">
      <h3 className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Live agents · {windows.length}
      </h3>
      <ul className="space-y-0.5">
        {windows.map((agent) => (
          <li key={agentKey(agent)} className="group">
            <div className="flex items-center rounded-md pr-1 hover:bg-accent">
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
              <CloseAgentButton agent={agent} className="opacity-60 hover:opacity-100 md:opacity-0 md:group-hover:opacity-100" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
