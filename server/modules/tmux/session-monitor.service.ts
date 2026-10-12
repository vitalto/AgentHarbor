import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readClaudeStatuses, type ClaudeStatus } from '@/modules/tmux/claude-status.js';
import { paneRegistry, type PaneRegistry, type PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { tmuxService, type TmuxService } from '@/modules/tmux/tmux.service.js';
import { createTranscriptTail, type TranscriptTail } from '@/modules/tmux/transcript-tail.js';
import {
  isEmptyFreeTextSlot,
  isInputPromptLine,
  isInputReady,
  keysForOption,
  keysToReachOption,
  parseTuiPrompt,
  type QuestionStep,
  type TuiPrompt,
} from '@/modules/tmux/tui-prompt.js';

/** A websocket (or anything with the same surface) watching a session. */
export type MonitorSocket = { readyState: number; send(data: string): void };

/** The slice of a chat run the monitor drives. */
export type MonitorRunWriter = {
  send(message: unknown): void;
};

/**
 * Everything the monitor needs from the rest of the app, injected by the
 * composition root so this module does not import the websocket or provider
 * modules (which import it).
 */
export type SessionMonitorDependencies = {
  tmux: TmuxService;
  registry: PaneRegistry;
  readStatuses: () => Promise<Map<string, ClaudeStatus>>;
  /** Provider (Claude) session id of an app session, or null when none is assigned yet. */
  resolveProviderSessionId: (appSessionId: string) => string | null;
  /** Transcript path recorded for the app session, used when no pane reports one. */
  resolveTranscriptPath: (appSessionId: string) => string | null;
  normalize: (row: unknown, providerSessionId: string) => unknown[];
  runs: {
    isProcessing(appSessionId: string): boolean;
    startRun(appSessionId: string, providerSessionId: string): MonitorRunWriter | null;
    getWriter(appSessionId: string): MonitorRunWriter | null;
    attach(appSessionId: string, socket: MonitorSocket): void;
    complete(appSessionId: string, exitCode: number): void;
  };
  now?: () => number;
};

type Watch = {
  appSessionId: string;
  sockets: Set<MonitorSocket>;
  tail: TranscriptTail | null;
  tailPath: string | null;
  prompt: TuiPrompt | null;
  promptKey: string | null;
  screenKey: string | null;
  lastScreenAt: number;
  subagentsCheckedAt: number;
  /** Newest write time among the session's subagent transcripts, as last seen. */
  subagentsWrittenAt: number | null;
  turn: { startedAt: number; sawActivity: boolean; idleTicks: number } | null;
  turnWaiters: Array<(exitCode: number) => void>;
};

const OPEN_STATE = 1;
const TICK_MS = 750;
const SCREEN_INTERVAL_MS = 1200;
/** Subagent folders can hold dozens of large transcripts on a slow mount; look at them only this often. */
const SUBAGENTS_CHECK_MS = 3000;
const SCREEN_TAIL_LINES = 14;
/** A turn the web just sent that never turned busy (e.g. a slash command) is over after this long. */
const TURN_START_GRACE_MS = 20_000;
/** The TUI absorbs a paste at its own pace ("Pasting…"); this many polls bound the wait (~3 s). */
const FREE_TEXT_LANDING_POLLS = 30;
const FREE_TEXT_POLL_MS = 100;

const withoutWhitespace = (text: string) => text.replace(/\s+/g, '');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The cursor sits on a free-text slot that now shows the start of `text` (long answers wrap into the detail lines). */
function showsFreeText(prompt: TuiPrompt | null, text: string): boolean {
  const slot = prompt?.options.find((option) => option.selected);
  if (!slot?.freeText) {
    return false;
  }
  return withoutWhitespace(`${slot.label}${slot.detail ?? ''}`).includes(withoutWhitespace(text).slice(0, 20));
}

/** Latest mtime of the .jsonl files in a directory tree (workflows nest one level deeper), or null if it does not exist. */
async function newestWriteUnder(directory: string, depth = 0): Promise<number | null> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let candidate: number | null = null;
    if (entry.isDirectory() && depth < 3) {
      candidate = await newestWriteUnder(entryPath, depth + 1);
    } else if (entry.name.endsWith('.jsonl')) {
      candidate = (await fsp.stat(entryPath).catch(() => null))?.mtimeMs ?? null;
    }
    if (candidate !== null && (newest === null || candidate > newest)) {
      newest = candidate;
    }
  }
  return newest;
}

function sendJson(socket: MonitorSocket, payload: unknown): void {
  if (socket.readyState === OPEN_STATE) {
    socket.send(JSON.stringify(payload));
  }
}

/** The part of the pane above the input box: what Claude is printing right now. */
export function screenTail(lines: string[]): string[] {
  let end = lines.length;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (isInputPromptLine(lines, index)) {
      end = index - 1;
      break;
    }
  }
  // Far right-aligned lines are status chrome (effort/model badges), not output.
  const isOutput = (line: string) => line.trim() !== '' && line.length - line.trimStart().length < 40;
  return lines.slice(0, end).filter(isOutput).slice(-SCREEN_TAIL_LINES);
}

export function createSessionMonitor(deps: SessionMonitorDependencies) {
  const now = deps.now ?? Date.now;
  const watches = new Map<string, Watch>();
  /** Windows opened for a session whose SessionStart hook has not reported yet (e.g. stuck on the trust dialog). */
  const startingPanes = new Map<string, string>();
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  async function waitForFreeTextToLand(paneId: string, text: string): Promise<boolean> {
    for (let poll = 0; poll < FREE_TEXT_LANDING_POLLS; poll += 1) {
      if (showsFreeText(parseTuiPrompt(await deps.tmux.capturePane(paneId)), text)) {
        return true;
      }
      await delay(FREE_TEXT_POLL_MS);
    }
    return false;
  }

  function watchFor(appSessionId: string): Watch {
    let watch = watches.get(appSessionId);
    if (!watch) {
      watch = {
        appSessionId, sockets: new Set(), tail: null, tailPath: null, prompt: null, promptKey: null,
        screenKey: null, lastScreenAt: 0, subagentsCheckedAt: 0, subagentsWrittenAt: null, turn: null, turnWaiters: [],
      };
      watches.set(appSessionId, watch);
    }
    return watch;
  }

  function broadcast(watch: Watch, payload: Record<string, unknown>): void {
    const framed = { sessionId: watch.appSessionId, timestamp: new Date(now()).toISOString(), ...payload };
    for (const socket of watch.sockets) {
      if (socket.readyState !== OPEN_STATE) {
        watch.sockets.delete(socket);
        continue;
      }
      sendJson(socket, framed);
    }
  }

  function finishTurn(watch: Watch, exitCode: number): void {
    deps.runs.complete(watch.appSessionId, exitCode);
    watch.turn = null;
    const waiters = watch.turnWaiters.splice(0);
    waiters.forEach((resolve) => resolve(exitCode));
  }

  function emitPrompt(watch: Watch, prompt: TuiPrompt | null): void {
    const key = prompt ? JSON.stringify(prompt) : null;
    if (key === watch.promptKey) {
      return;
    }
    watch.prompt = prompt;
    watch.promptKey = key;
    broadcast(watch, prompt ? { kind: 'tui_prompt', prompt } : { kind: 'tui_prompt_cleared' });
  }

  function emitScreen(watch: Watch, lines: string[]): void {
    const key = lines.join('\n');
    if (key === watch.screenKey) {
      return;
    }
    watch.screenKey = key;
    broadcast(watch, { kind: 'tui_screen', lines });
  }

  async function syncTranscript(watch: Watch, providerSessionId: string, pane: PaneSession | undefined): Promise<void> {
    const transcriptPath = pane?.transcriptPath ?? deps.resolveTranscriptPath(watch.appSessionId);
    if (!transcriptPath) {
      return;
    }
    if (transcriptPath !== watch.tailPath) {
      watch.tailPath = transcriptPath;
      watch.tail = createTranscriptTail(transcriptPath);
    }
    const { rows, reset } = await watch.tail!.poll();
    if (reset) {
      // History was rewritten under us; the client re-reads it over REST on complete.
      broadcast(watch, { kind: 'transcript_reset' });
    }
    const writer = deps.runs.getWriter(watch.appSessionId);
    for (const row of rows) {
      for (const message of deps.normalize(row, providerSessionId)) {
        if (writer) {
          writer.send(message);
        } else {
          broadcast(watch, message as Record<string, unknown>);
        }
      }
    }
  }

/**
   * Subagents (Agent tool, workflows) write their own transcripts under
   * `<session>/subagents/`, often long after the main turn ended (background
   * agents). The live tail sees only the main transcript, so a change there is
   * announced and the viewer re-reads the history, which attaches subagent
   * timelines to their tool cards.
   */
  async function syncSubagents(watch: Watch, providerSessionId: string): Promise<void> {
    if (!watch.tailPath || now() - watch.subagentsCheckedAt < SUBAGENTS_CHECK_MS) {
      return;
    }
    watch.subagentsCheckedAt = now();
    const writtenAt = await newestWriteUnder(path.join(path.dirname(watch.tailPath), providerSessionId, 'subagents'));
    if (writtenAt === null) {
      return;
    }
    const previous = watch.subagentsWrittenAt;
    watch.subagentsWrittenAt = writtenAt;
    if (previous !== null && writtenAt > previous) {
      broadcast(watch, { kind: 'subagents_updated' });
    }
  }

  async function tickWatch(watch: Watch, panesBySession: Map<string, PaneSession>, statuses: Map<string, ClaudeStatus>) {
    const providerSessionId = deps.resolveProviderSessionId(watch.appSessionId);
    if (!providerSessionId) {
      return;
    }
    const pane = panesBySession.get(providerSessionId);
    const startingPaneId = startingPanes.get(watch.appSessionId);
    // Still starting (the registry may already guess its session from the newest transcript in its folder):
    // only menus on its screen matter, e.g. the folder-trust dialog Claude shows on every start in the home
    // directory, and the turn must not be failed as "window closed".
    if (startingPaneId && (!pane || !pane.registered)) {
      emitPrompt(watch, parseTuiPrompt(await deps.tmux.capturePane(startingPaneId).catch(() => [])));
      return;
    }
    // A session open outside tmux (e.g. a Windows console) is mirrored read-only from its status file and transcript.
    const runsElsewhere = !pane && statuses.has(providerSessionId);
    const activity = pane || runsElsewhere ? statuses.get(providerSessionId)?.activity ?? 'idle' : null;
    const active = activity === 'busy' || activity === 'waiting';

    if (active && !deps.runs.isProcessing(watch.appSessionId)) {
      // Typed in the terminal (phone, terminal tab): surface it as a run so every viewer sees it live.
      if (deps.runs.startRun(watch.appSessionId, providerSessionId)) {
        watch.sockets.forEach((socket) => deps.runs.attach(watch.appSessionId, socket));
        watch.turn = { startedAt: now(), sawActivity: true, idleTicks: 0 };
      }
    }

    await syncTranscript(watch, providerSessionId, pane);
    await syncSubagents(watch, providerSessionId);

    // An unregistered window (started without our hook, or stuck before it fires) may sit on a dialog with no status file.
    if (pane && (activity === 'waiting' || watch.prompt || !pane.registered)) {
      await deps.tmux.restoreShrunkWindow(pane.pane.windowId).catch(() => false);
      emitPrompt(watch, parseTuiPrompt(await deps.tmux.capturePane(pane.pane.paneId)));
    } else if (watch.prompt) {
      emitPrompt(watch, null);
    }

    if (pane && activity === 'busy' && now() - watch.lastScreenAt >= SCREEN_INTERVAL_MS) {
      watch.lastScreenAt = now();
      emitScreen(watch, screenTail(await deps.tmux.capturePane(pane.pane.paneId)));
    } else if (!active && watch.screenKey) {
      emitScreen(watch, []);
    }

    if (!watch.turn) {
      return;
    }
    if (!pane && !runsElsewhere) {
      broadcast(watch, { kind: 'error', content: 'The Claude window for this session closed.' });
      finishTurn(watch, 1);
      return;
    }
    if (active) {
      watch.turn.sawActivity = true;
      watch.turn.idleTicks = 0;
      return;
    }
    watch.turn.idleTicks += 1;
    // One extra idle tick lets rows written right as the turn ended reach the tail first.
    const ended = watch.turn.sawActivity ? watch.turn.idleTicks >= 2 : now() - watch.turn.startedAt > TURN_START_GRACE_MS;
    if (ended) {
      finishTurn(watch, 0);
    }
  }

  async function tick(): Promise<void> {
    if (ticking || watches.size === 0) {
      return;
    }
    ticking = true;
    try {
      const [panes, statuses] = await Promise.all([deps.registry.refresh(), deps.readStatuses()]);
      const panesBySession = new Map<string, PaneSession>();
      for (const pane of panes) {
        if (pane.providerSessionId && (pane.registered || !panesBySession.has(pane.providerSessionId))) {
          panesBySession.set(pane.providerSessionId, pane);
        }
      }
      for (const watch of [...watches.values()]) {
        try {
          await tickWatch(watch, panesBySession, statuses);
        } catch (error) {
          console.error('[AgentHarbor] session monitor tick failed', watch.appSessionId, error);
        }
        const idle = !watch.turn && !deps.runs.isProcessing(watch.appSessionId);
        if (watch.sockets.size === 0 && idle) {
          watches.delete(watch.appSessionId);
        }
      }
    } finally {
      ticking = false;
    }
  }

  const monitor = {
    start(): void {
      timer ??= setInterval(() => void tick(), TICK_MS);
      timer.unref?.();
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    tick,

    watch(appSessionId: string, socket: MonitorSocket): void {
      const watch = watchFor(appSessionId);
      watch.sockets.add(socket);
      if (watch.prompt) {
        sendJson(socket, { kind: 'tui_prompt', sessionId: appSessionId, prompt: watch.prompt });
      }
    },

    unwatchSocket(socket: MonitorSocket): void {
      for (const watch of watches.values()) {
        watch.sockets.delete(socket);
      }
    },

    /** Marks a web-sent turn as started; completes when Claude goes idle again (or never starts). */
    beginTurn(appSessionId: string): Promise<number> {
      const watch = watchFor(appSessionId);
      watch.turn = { startedAt: now(), sawActivity: false, idleTicks: 0 };
      return new Promise((resolve) => watch.turnWaiters.push(resolve));
    },

    currentPrompt(appSessionId: string): TuiPrompt | null {
      return watches.get(appSessionId)?.prompt ?? null;
    },

    async findPane(appSessionId: string): Promise<PaneSession | null> {
      const providerSessionId = deps.resolveProviderSessionId(appSessionId);
      return providerSessionId ? deps.registry.findPaneForSession(providerSessionId) : null;
    },

    setStartingPane(appSessionId: string, paneId: string | null): void {
      if (paneId) {
        startingPanes.set(appSessionId, paneId);
      } else {
        startingPanes.delete(appSessionId);
      }
    },

    /** The session's pane: its registered window, or the one still starting up. */
    async resolvePaneId(appSessionId: string): Promise<string | null> {
      return (await monitor.findPane(appSessionId))?.pane.paneId ?? startingPanes.get(appSessionId) ?? null;
    },

    async sendKeys(appSessionId: string, keys: string[]): Promise<boolean> {
      const paneId = await monitor.resolvePaneId(appSessionId);
      if (!paneId) {
        return false;
      }
      await deps.tmux.sendKeys(paneId, keys);
      return true;
    },

    /** Answers the open menu; a free-text option needs `freeText`, which is typed into it before Enter. */
    async chooseOption(appSessionId: string, optionIndex: number, freeText?: string): Promise<boolean> {
      const paneId = await monitor.resolvePaneId(appSessionId);
      if (!paneId) {
        return false;
      }
      // Re-read the screen: the menu cursor may have moved since the prompt was broadcast.
      const prompt = parseTuiPrompt(await deps.tmux.capturePane(paneId));
      if (!prompt || optionIndex < 0 || optionIndex >= prompt.options.length) {
        return false;
      }
      const option = prompt.options[optionIndex];
      if (!option.freeText) {
        await deps.tmux.sendKeys(paneId, keysForOption(prompt, optionIndex));
        return true;
      }
      // Enter on an empty free-text slot makes Claude decline the whole AskUserQuestion.
      if (!freeText?.trim()) {
        return false;
      }
      await deps.tmux.sendKeys(paneId, keysToReachOption(prompt, optionIndex));
      if (!isEmptyFreeTextSlot(option)) {
        // A paste appends to what the slot already holds, e.g. an answer given before going back.
        await deps.tmux.sendKeys(paneId, ['End', 'C-u']);
      }
      await deps.tmux.pasteText(paneId, freeText);
      if (!(await waitForFreeTextToLand(paneId, freeText))) {
        return false;
      }
      // Typing ticks a multi-select slot already; Enter would untick it.
      if (option.checked === null) {
        await deps.tmux.sendKeys(paneId, ['Enter']);
      }
      return true;
    },

    /** Moves an AskUserQuestion set to its previous or next tab (question or review step). */
    async switchQuestion(appSessionId: string, step: QuestionStep): Promise<boolean> {
      const paneId = await monitor.resolvePaneId(appSessionId);
      if (!paneId) {
        return false;
      }
      const prompt = parseTuiPrompt(await deps.tmux.capturePane(paneId));
      if (!prompt?.questionTabs) {
        return false;
      }
      // In a free-text slot ←/→ move the text cursor instead of switching questions.
      const leaveFreeText = prompt.options.some((option) => option.selected && option.freeText) ? keysToReachOption(prompt, 0) : [];
      await deps.tmux.sendKeys(paneId, [...leaveFreeText, step === 'previous' ? 'Left' : 'Right']);
      return true;
    },

    async isInputReady(paneId: string): Promise<boolean> {
      return isInputReady(await deps.tmux.capturePane(paneId));
    },

    async readPrompt(paneId: string): Promise<TuiPrompt | null> {
      return parseTuiPrompt(await deps.tmux.capturePane(paneId));
    },

    /** Pushes a prompt seen outside the tick (e.g. a trust dialog while a window starts). */
    announcePrompt(appSessionId: string, prompt: TuiPrompt | null): void {
      emitPrompt(watchFor(appSessionId), prompt);
    },
  };
  return monitor;
}

export type SessionMonitor = ReturnType<typeof createSessionMonitor>;

let configuredMonitor: SessionMonitor | null = null;

/** Called once by the composition root with the app-level dependencies. */
export function configureSessionMonitor(
  deps: Omit<SessionMonitorDependencies, 'tmux' | 'registry' | 'readStatuses'> & Partial<SessionMonitorDependencies>,
): SessionMonitor {
  configuredMonitor?.stop();
  configuredMonitor = createSessionMonitor({ tmux: tmuxService, registry: paneRegistry, readStatuses: () => readClaudeStatuses(), ...deps });
  return configuredMonitor;
}

export function getSessionMonitor(): SessionMonitor {
  if (!configuredMonitor) {
    throw new Error('Session monitor used before configureSessionMonitor()');
  }
  return configuredMonitor;
}
