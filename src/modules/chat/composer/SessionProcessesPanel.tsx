import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, SquareTerminal, X } from 'lucide-react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { BackgroundCommandInfo } from '@/shared/types';
import { cn } from '@/shared/utils';
import { formatTaskDuration } from '@/modules/chat/utils/backgroundTasks';

/** Mirrors server SessionBackgroundCommand. */
export type SessionBackgroundCommand = BackgroundCommandInfo & { toolUseId: string };

type BackgroundCommandOutput = { text: string; truncated: boolean };

const RUNNING_POLL_MS = 3000;
const OUTPUT_POLL_MS = 2000;
const ELAPSED_TICK_MS = 1000;
const MAX_LABEL_LENGTH = 100;

const STATUS_LABELS: Record<BackgroundCommandInfo['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** What a command is called: the description the agent gave it, else the head of the command. */
export function describeCommand(command: Pick<BackgroundCommandInfo, 'command' | 'description'>): string {
  if (command.description) {
    return command.description;
  }
  const head = command.command.split('\n', 1)[0]?.trim() ?? '';
  return head.length > MAX_LABEL_LENGTH ? `${head.slice(0, MAX_LABEL_LENGTH - 1)}…` : head;
}

function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function CommandOutput({ sessionId, command }: { sessionId: string; command: SessionBackgroundCommand }) {
  const [output, setOutput] = useState<BackgroundCommandOutput | null>(null);
  const isRunning = command.status === 'running';

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await api.backgroundCommandOutput(sessionId, command.taskId);
        const body = (await response.json()) as { success?: boolean; data?: BackgroundCommandOutput };
        if (!cancelled && body.success && body.data) {
          setOutput(body.data);
        }
      } catch {
        // Keep what was shown; a running command is re-read on the next tick.
      }
    };
    void load();
    if (!isRunning) {
      return () => { cancelled = true; };
    }
    const timer = window.setInterval(() => void load(), OUTPUT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, command.taskId, isRunning]);

  return (
    <div className="mb-2 ml-5 mt-1 space-y-1 border-l border-border/60 pl-3">
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{command.command}</pre>
      {output === null ? (
        <div className="text-[11px] text-muted-foreground/70">Reading output…</div>
      ) : output.text ? (
        <pre className="max-h-[35vh] overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[11px] text-foreground">
          {output.truncated ? '…\n' : ''}{output.text}
        </pre>
      ) : (
        <div className="text-[11px] text-muted-foreground/70">No output yet</div>
      )}
    </div>
  );
}

type CommandRowProps = {
  sessionId: string;
  command: SessionBackgroundCommand;
  now: number;
  onStop: (taskId: string) => void;
};

function CommandRow({ sessionId, command, now, onStop }: CommandRowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const isRunning = command.status === 'running';
  const state = isRunning
    ? formatTaskDuration(Math.max(0, now - command.startedAt))
    : STATUS_LABELS[command.status];

  return (
    <li>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          title={command.command}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent"
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              isRunning ? 'animate-pulse bg-blue-500' : command.status === 'failed' ? 'bg-red-500/70' : 'bg-muted-foreground/40',
            )}
            aria-label={STATUS_LABELS[command.status]}
          />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{describeCommand(command)}</span>
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{state}</span>
        </button>
        {isRunning && (
          <button
            type="button"
            onClick={() => onStop(command.taskId)}
            aria-label="Stop"
            title="Stop"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {isOpen && <CommandOutput sessionId={sessionId} command={command} />}
    </li>
  );
}

type SessionProcessesPanelProps = {
  sessionId: string;
  /** Changes whenever the transcript grows, so a command launched or finished just now is picked up. */
  refreshKey: number;
};

/**
 * The commands this session backgrounded (`run_in_background`), above the
 * composer next to its agents: how many still run, and — opened — each one's
 * command and the end of its output. A running one can be stopped from here;
 * typing a new message does not stop them.
 */
export default function SessionProcessesPanel({ sessionId, refreshKey }: SessionProcessesPanelProps) {
  const { sendMessage } = useWebSocket();
  const [commands, setCommands] = useState<SessionBackgroundCommand[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [showFinished, setShowFinished] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.sessionBackgroundCommands(sessionId);
      const body = (await response.json()) as { success?: boolean; data?: SessionBackgroundCommand[] };
      if (body.success && Array.isArray(body.data)) {
        setCommands(body.data);
      }
    } catch {
      // Keep what was shown; the next update retries.
    }
  }, [sessionId]);

  useEffect(() => {
    setCommands([]);
    setIsExpanded(true);
    setShowFinished(false);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const running = commands.filter((command) => command.status === 'running');
  const finished = commands.filter((command) => command.status !== 'running');

  // A command ends without the transcript necessarily growing (its Claude exited), so running ones are re-read.
  useEffect(() => {
    if (running.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => void load(), RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, running.length]);

  const now = useTickingNow(running.length > 0);

  const stop = useCallback((taskId: string) => {
    sendMessage({ type: 'chat.stop-task', sessionId, taskId });
  }, [sendMessage, sessionId]);

  // Finished commands alone are history: the panel shows up only while something runs.
  if (running.length === 0) {
    return null;
  }

  const visible = showFinished ? commands : running;

  return (
    <div className="mx-auto mb-2 max-w-[54.25rem] rounded-lg border border-border/60 bg-card/60 px-2 py-1" data-testid="session-processes">
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <SquareTerminal className="h-3.5 w-3.5 text-blue-500" />
        <span className="flex-1">
          Processes · {running.length} running
          {finished.length > 0 ? ` · ${finished.length} finished` : ''}
        </span>
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {isExpanded && (
        <div className="max-h-[55vh] overflow-y-auto pb-1">
          <ul className="space-y-0.5">
            {visible.map((command) => (
              <CommandRow key={command.taskId} sessionId={sessionId} command={command} now={now} onStop={stop} />
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
