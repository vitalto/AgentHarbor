import { SquareTerminal } from 'lucide-react';

import { LLMProviderLogo, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { AgentWindow } from '@/shared/hooks/useAgentWindows';
import type { LLMProvider } from '@/shared/types';

const ACTIVITY_STYLES: Record<AgentWindow['activity'], { className: string; label: string }> = {
  idle: { className: 'text-green-600 dark:text-green-400', label: 'idle' },
  busy: { className: 'animate-pulse text-blue-600 dark:text-blue-400', label: 'working' },
  waiting: { className: 'text-amber-600 dark:text-amber-400', label: 'waiting for your answer' },
};

type AgentWindowBadgeProps = {
  provider: LLMProvider;
  agentWindow: AgentWindow | null;
  className?: string;
};

/** The row icon: a terminal glyph colored by activity when Claude runs in a tmux window, the provider logo otherwise. */
export default function AgentWindowBadge({ provider, agentWindow, className }: AgentWindowBadgeProps) {
  if (!agentWindow) {
    return <LLMProviderLogo provider={provider} className={className} />;
  }
  const style = ACTIVITY_STYLES[agentWindow.activity];
  return (
    <Tooltip content={`tmux window "${agentWindow.windowName}" · ${style.label}`} position="top">
      <span data-testid="agent-window-badge" className="inline-flex">
        <SquareTerminal className={cn(className, style.className)} aria-label={`Live in tmux, ${style.label}`} />
      </span>
    </Tooltip>
  );
}
