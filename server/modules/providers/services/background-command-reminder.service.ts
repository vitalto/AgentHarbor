import { listRunningBackgroundCommands } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  getAgentConfig,
  paneRegistry,
  readClaudeProcesses,
  readInputBox,
  tmuxService,
  typeIntoAgent,
  type ClaudeProcess,
  type PaneSession,
} from '@/modules/tmux/index.js';

const SWEEP_INTERVAL_MS = 60_000;
const MAX_COMMAND_CHARS = 120;

export type RunningCommand = { taskId: string; command: string; startedAt: number };

/** How many reminders a command running this long has earned: after 1, 3, 7, 15… intervals, each gap twice the last. */
export function remindersDueAfter(runningMs: number, intervalMs: number): number {
  if (intervalMs <= 0) {
    return 0;
  }
  let reminders = 0;
  for (let reminderAt = intervalMs; runningMs >= reminderAt; reminderAt = reminderAt * 2 + intervalMs) {
    reminders += 1;
  }
  return reminders;
}

/**
 * Compares what one session's running commands have earned with what was
 * already sent. `counts` is the earned number per still-running command:
 * what the ledger should hold once the due ones are delivered.
 */
export function settleSessionReminders(
  sent: ReadonlyMap<string, number> | undefined,
  commands: RunningCommand[],
  now: number,
  intervalMs: number,
): { due: RunningCommand[]; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const due: RunningCommand[] = [];
  for (const command of commands) {
    const earned = remindersDueAfter(now - command.startedAt, intervalMs);
    counts.set(command.taskId, earned);
    if (earned > (sent?.get(command.taskId) ?? 0)) {
      due.push(command);
    }
  }
  return { due, counts };
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function summarizeCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').replaceAll('`', "'").trim();
  return oneLine.length > MAX_COMMAND_CHARS ? `${oneLine.slice(0, MAX_COMMAND_CHARS - 1)}…` : oneLine;
}

export function formatBackgroundReminder(commands: RunningCommand[], now: number): string {
  const describe = (command: RunningCommand) => `${formatDuration(now - command.startedAt)}: \`${summarizeCommand(command.command)}\``;
  if (commands.length === 1) {
    return `[AgentHarbor] Background command running ${describe(commands[0])}. Intended? If stuck, stop it.`;
  }
  return [
    '[AgentHarbor] Background commands running long:',
    ...commands.map((command) => `- ${describe(command)}`),
    'Intended? If stuck, stop them.',
  ].join('\n');
}

/** Reminders already sent, per Claude session and background task id. Memory only: a restart re-primes it. */
const sentReminders = new Map<string, Map<string, number>>();
let primed = false;

function newestProcessOf(processes: ClaudeProcess[], providerSessionId: string): ClaudeProcess | null {
  return processes
    .filter((claude) => claude.providerSessionId === providerSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Types only into an empty input box, so a draft someone left in the terminal is never sent along. */
async function remindAgent(pane: PaneSession, text: string): Promise<boolean> {
  const box = readInputBox(await tmuxService.capturePane(pane.pane.paneId));
  if (!box || box.text !== '' || box.pasting) {
    return false;
  }
  await typeIntoAgent(pane.pane.paneId, text);
  return true;
}

/**
 * Sends a resting agent (turn over, a background command still running) a
 * short note when a command has run 1, 3, 7… reminder intervals since its
 * start, so a waiter stuck on a condition that will never come is noticed.
 * A busy agent or one waiting on a menu gets it once it rests. The first
 * sweep after a start only records what is already due: a restart sends nothing.
 */
export async function sweepBackgroundCommandReminders(now: number = Date.now()): Promise<number> {
  const intervalMs = getAgentConfig().backgroundReminderMinutes * 60_000;
  if (intervalMs <= 0) {
    return 0;
  }
  const [panes, processes] = await Promise.all([paneRegistry.refresh(), readClaudeProcesses()]);
  const liveSessions = new Set(processes.map((claude) => claude.providerSessionId));
  for (const providerSessionId of sentReminders.keys()) {
    if (!liveSessions.has(providerSessionId)) {
      sentReminders.delete(providerSessionId);
    }
  }

  let reminded = 0;
  for (const pane of panes) {
    if (!pane.registered || !pane.providerSessionId || !pane.transcriptPath) {
      continue;
    }
    const claude = newestProcessOf(processes, pane.providerSessionId);
    // Priming covers busy agents too, or one resting after a restart would be reminded of what it already was.
    if (!claude || (primed && claude.status !== 'shell')) {
      continue;
    }
    const commands = await listRunningBackgroundCommands(pane.transcriptPath, pane.providerSessionId, claude.startedAt);
    const sent = sentReminders.get(pane.providerSessionId);
    const { due, counts } = settleSessionReminders(sent, commands, now, intervalMs);
    if (primed && due.length > 0) {
      // Not delivered (a draft in the box, the window just closed): the ledger stays, so the next sweep retries.
      const delivered = await remindAgent(pane, formatBackgroundReminder(due, now)).catch((error) => {
        console.error(`[AgentHarbor] could not remind ${pane.pane.windowName} of its background commands`, error);
        return false;
      });
      if (!delivered) {
        continue;
      }
      reminded += 1;
    }
    sentReminders.set(pane.providerSessionId, counts);
  }
  primed = true;
  return reminded;
}

export function startBackgroundCommandReminders(): void {
  const sweep = () => void sweepBackgroundCommandReminders()
    .catch((error) => console.error('[AgentHarbor] background command reminder sweep failed', error));
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
