import { useCallback, useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { DiffLine, Project, ServerEvent } from '@/shared/types';
import { cn } from '@/shared/utils';
import { AgentActivityTimeline } from '@/modules/chat/tools/WorkflowPanel';

/** Mirrors server/shared/types.ts SessionSubagent. */
export type SessionSubagent = {
  agentId: string;
  description?: string;
  agentType?: string;
  background: boolean;
  running: boolean;
  startedAt: string | null;
  updatedAt: string;
};

const RUNNING_POLL_MS = 5000;

function formatAge(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

type AgentRowProps = {
  sessionId: string;
  subagent: SessionSubagent;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
};

function AgentRow({ sessionId, subagent, onFileOpen, createDiff, selectedProject }: AgentRowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const readActivity = useCallback(() => api.subagentActivity(sessionId, subagent.agentId), [sessionId, subagent.agentId]);

  return (
    <li>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent"
      >
        {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', subagent.running ? 'animate-pulse bg-blue-500' : 'bg-muted-foreground/40')}
          aria-label={subagent.running ? 'running' : 'finished'}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{subagent.description || subagent.agentId}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {subagent.agentType}
          {subagent.background ? ' · background' : ''}
          {' · '}
          {subagent.running ? 'working' : formatAge(subagent.updatedAt)}
        </span>
      </button>
      {isOpen && (
        <div className="mb-2 ml-5 mt-1 max-h-[45vh] overflow-y-auto border-l border-border/60 pl-3">
          <AgentActivityTimeline
            readActivity={readActivity}
            isRunning={subagent.running}
            onFileOpen={onFileOpen}
            createDiff={createDiff}
            selectedProject={selectedProject}
          />
        </div>
      )}
    </li>
  );
}

type SessionAgentsPanelProps = {
  sessionId: string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
};

/**
 * The subagents this session spawned (Agent tool), above the composer: how many
 * are working right now, and — opened — each one's own steps, which never show
 * up in the main conversation while they run in the background.
 */
export default function SessionAgentsPanel({ sessionId, onFileOpen, createDiff, selectedProject }: SessionAgentsPanelProps) {
  const { subscribe } = useWebSocket();
  const [subagents, setSubagents] = useState<SessionSubagent[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFinished, setShowFinished] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.sessionSubagents(sessionId);
      const body = (await response.json()) as { success?: boolean; data?: SessionSubagent[] };
      if (body.success && Array.isArray(body.data)) {
        setSubagents(body.data);
      }
    } catch {
      // Keep what was shown; the next update retries.
    }
  }, [sessionId]);

  useEffect(() => {
    setSubagents([]);
    setIsExpanded(false);
    setShowFinished(false);
    void load();
  }, [load]);

  // The server announces subagent transcript writes for watched sessions.
  useEffect(() => subscribe((event: ServerEvent) => {
    if (event.kind === 'subagents_updated' && event.sessionId === sessionId) {
      void load();
    }
  }), [load, sessionId, subscribe]);

  const runningCount = subagents.filter((subagent) => subagent.running).length;

  // "Running" is judged by recent writes, so it has to be re-read for agents to settle.
  useEffect(() => {
    if (runningCount === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => void load(), RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, runningCount]);

  if (subagents.length === 0) {
    return null;
  }

  const finished = subagents.filter((subagent) => !subagent.running);
  const visible = showFinished ? subagents : subagents.filter((subagent) => subagent.running);

  return (
    <div className="mx-auto mb-2 max-w-[54.25rem] rounded-lg border border-border/60 bg-card/60 px-2 py-1" data-testid="session-agents">
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <Bot className={cn('h-3.5 w-3.5', runningCount > 0 && 'text-blue-500')} />
        <span className="flex-1">
          Agents
          {runningCount > 0 ? ` · ${runningCount} working` : ''}
          {finished.length > 0 ? ` · ${finished.length} finished` : ''}
        </span>
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {isExpanded && (
        <div className="max-h-[55vh] overflow-y-auto pb-1">
          <ul className="space-y-0.5">
            {visible.map((subagent) => (
              <AgentRow
                key={subagent.agentId}
                sessionId={sessionId}
                subagent={subagent}
                onFileOpen={onFileOpen}
                createDiff={createDiff}
                selectedProject={selectedProject}
              />
            ))}
          </ul>
          {finished.length > 0 && (
            <button
              type="button"
              onClick={() => setShowFinished((shown) => !shown)}
              className="mt-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {showFinished ? 'Hide finished' : `Show finished (${finished.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
