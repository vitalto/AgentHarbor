import { useNavigate } from 'react-router-dom';

import { useAgentWindows } from '@/shared/hooks/useAgentWindows';
import AgentWindowBadge, { describeAgentActivity, describeAgentLocation } from '@/modules/sidebar/AgentWindowBadge';

function projectLabel(projectPath: string | null): string {
  if (!projectPath) {
    return '';
  }
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

/** Every Claude agent running right now, wherever it runs, one click from its chat. */
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
        {windows.map((agentWindow) => (
          <li key={`${agentWindow.location}-${agentWindow.providerSessionId}-${agentWindow.windowName ?? agentWindow.pid}`}>
            <button
              type="button"
              onClick={() => navigate(`/session/${agentWindow.sessionId}`)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-accent"
              title={`${describeAgentLocation(agentWindow)} · ${describeAgentActivity(agentWindow)}`}
            >
              <AgentWindowBadge provider="claude" agentWindow={agentWindow} className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{agentWindow.title || agentWindow.windowName || 'Claude session'}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {projectLabel(agentWindow.projectPath)}
                  {agentWindow.location !== 'tmux' ? ' · outside tmux' : ''}
                  {' · '}
                  {describeAgentActivity(agentWindow)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
