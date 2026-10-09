import type { Project, ProjectSession } from '@/shared/types';
import { Shell } from '@/modules/shell';
import StandaloneShellEmptyState from '@/modules/standalone-shell/StandaloneShellEmptyState';
import StandaloneShellHeader from '@/modules/standalone-shell/StandaloneShellHeader';

type StandaloneShellProps = {
  project?: Project | null;
  session?: ProjectSession | null;
  isPlainShell?: boolean | null;
  isActive?: boolean;
  autoConnect?: boolean;
  onClose?: (() => void) | null;
  title?: string | null;
  className?: string;
  showHeader?: boolean;
  compact?: boolean;
  minimal?: boolean;
};

/**
 * This module's only public export: used by the project-workspace module for its shell tab and by
 * provider-auth for its login shell. With a session it shows that session's tmux window, otherwise
 * the project's shell window.
 */
export default function StandaloneShell({
  project = null,
  session = null,
  isPlainShell = null,
  isActive = true,
  autoConnect = true,
  onClose = null,
  title = null,
  className = '',
  showHeader = true,
  compact = false,
  minimal = false,
}: StandaloneShellProps) {
  // Keep `compact` in the public API for compatibility with existing callers.
  void compact;

  const shouldUsePlainShell = isPlainShell !== null ? isPlainShell : !session;

  if (!project) {
    return <StandaloneShellEmptyState className={className} />;
  }

  return (
    <div className={`flex h-full w-full flex-col ${className}`}>
      {!minimal && showHeader && title && (
        <StandaloneShellHeader title={title} onClose={onClose} />
      )}

      <div className="min-h-0 w-full flex-1">
        <Shell
          selectedProject={project}
          selectedSession={session}
          isPlainShell={shouldUsePlainShell}
          isActive={isActive}
          minimal={minimal}
          autoConnect={minimal ? true : autoConnect}
        />
      </div>
    </div>
  );
}
