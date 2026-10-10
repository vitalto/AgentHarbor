import { Monitor, SquareTerminal, TriangleAlert } from 'lucide-react';

import { LLMProviderLogo, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { AgentWindow } from '@/shared/hooks/useAgentWindows';
import type { LLMProvider } from '@/shared/types';

const ACTIVITY_STYLES: Record<AgentWindow['activity'], { className: string; label: string }> = {
  idle: { className: 'text-green-600 dark:text-green-400', label: 'idle' },
  busy: { className: 'animate-pulse text-blue-600 dark:text-blue-400', label: 'working' },
  waiting: { className: 'text-amber-600 dark:text-amber-400', label: 'waiting for your answer' },
};

export function describeAgentLocation(agentWindow: AgentWindow): string {
  if (agentWindow.location === 'tmux') {
    return `tmux window "${agentWindow.windowName}"`;
  }
  const where = agentWindow.location === 'windows' ? 'a Windows terminal' : 'another terminal';
  return `${where} (pid ${agentWindow.pid}), watch only`;
}

export function describeAgentActivity(agentWindow: AgentWindow): string {
  return ACTIVITY_STYLES[agentWindow.activity].label;
}

type AgentWindowBadgeProps = {
  provider: LLMProvider;
  agentWindow: AgentWindow | null;
  /** Size of the provider logo. */
  className?: string;
  /** Size of the live-window glyph, which is drawn as its own framed square and may fill the whole slot. */
  windowIconClassName?: string;
};

/**
 * The row icon of a session: a terminal glyph colored by activity while its
 * Claude runs (in tmux, or a monitor glyph when it runs in another terminal),
 * a warning when two processes hold it, the provider logo otherwise.
 */
export default function AgentWindowBadge({ provider, agentWindow, className, windowIconClassName = className }: AgentWindowBadgeProps) {
  if (!agentWindow) {
    return <LLMProviderLogo provider={provider} className={className} />;
  }
  const style = ACTIVITY_STYLES[agentWindow.activity];
  const Icon = agentWindow.duplicateProcesses ? TriangleAlert : agentWindow.location === 'tmux' ? SquareTerminal : Monitor;
  const tooltip = agentWindow.duplicateProcesses
    ? 'Two Claude processes hold this session; close one of them'
    : `${describeAgentLocation(agentWindow)} · ${style.label}`;
  return (
    <Tooltip content={tooltip} position="top">
      {/* Block-level: inline, the glyph sat on the text baseline of the tooltip's inline-block and rode high. */}
      <span data-testid="agent-window-badge" className="flex">
        <Icon
          className={cn(windowIconClassName, agentWindow.duplicateProcesses ? 'text-red-600 dark:text-red-400' : style.className)}
          aria-label={tooltip}
        />
      </span>
    </Tooltip>
  );
}
