import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { findSessionHolders, forgetWindowsProcessCache, readClaudeProcesses, type ClaudeProcess } from '@/modules/tmux/claude-status.js';
import { buildAgentLaunch, writeHookSettings } from '@/modules/tmux/agent-launch.js';
import { paneRegistry, type PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { toLocalPath } from '@/modules/tmux/path-translation.js';
import { getSessionMonitor } from '@/modules/tmux/session-monitor.service.js';
import { tmuxService, TmuxError, type AgentPane } from '@/modules/tmux/tmux.service.js';
import { readInputBox, type InputBox } from '@/modules/tmux/tui-prompt.js';

const REGISTRATION_TIMEOUT_MS = 120_000;
const INPUT_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 300;
const INPUT_POLL_MS = 100;
const PASTE_LANDING_TIMEOUT_MS = 10_000;
const SUBMIT_CONFIRM_TIMEOUT_MS = 3_000;
const SUBMIT_ATTEMPTS = 3;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
/** A pane's interop process and its claude.exe start within a few seconds of each other. */
const PANE_PROCESS_MATCH_MS = 60_000;
const CLOCK_TICKS_PER_SECOND = 100;
const TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AgentWindowError extends Error {}

/** The session's Claude in another terminal is not idle; moving it would cut that work off. */
export class AgentBusyElsewhereError extends AgentWindowError {
  constructor(readonly holder: ClaudeProcess) {
    super(
      `Claude in the other terminal (pid ${holder.pid}) reports "${holder.status}"`
      + `${holder.statusSince ? ` since ${new Date(holder.statusSince).toISOString()}` : ''}. `
      + 'Let it finish there, or close it anyway (whatever it is doing there stops).',
    );
  }
}

async function uniqueWindowName(base: string): Promise<string> {
  const taken = new Set((await tmuxService.listPanes()).map((pane) => pane.windowName));
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base}#${index}`)) {
    index += 1;
  }
  return `${base}#${index}`;
}

/**
 * Waits until the pane's SessionStart hook has reported. Menus that appear first
 * (the folder-trust dialog) are surfaced to the web so the user can answer them.
 */
async function waitForRegistration(appSessionId: string, paneId: string): Promise<PaneSession> {
  const monitor = getSessionMonitor();
  monitor.setStartingPane(appSessionId, paneId);
  try {
    const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const registered = await paneRegistry.waitForRegistration(paneId, POLL_MS * 3);
      if (registered) {
        return registered;
      }
      const alive = (await tmuxService.listPanes()).some((pane) => pane.paneId === paneId && !pane.dead);
      if (!alive) {
        throw new AgentWindowError('Claude exited right after starting. Open the terminal tab to see why.');
      }
    }
    throw new AgentWindowError('Claude did not finish starting within 2 minutes.');
  } finally {
    monitor.setStartingPane(appSessionId, null);
  }
}

export async function findAgentWindow(appSessionId: string): Promise<PaneSession | null> {
  return getSessionMonitor().findPane(appSessionId);
}

/**
 * Called only when the session has no tmux window: any live Claude process for
 * it then runs somewhere else (a Windows console, another terminal). Resuming
 * would start a second process writing the same transcript.
 */
export function assertNotOpenElsewhere(holders: ClaudeProcess[]): void {
  const running = holders[0];
  if (!running) {
    return;
  }
  const where = running.windowsPid ? 'a Windows terminal' : 'another terminal';
  throw new AgentWindowError(
    `This session is already open in ${where} (claude pid ${running.pid}${running.cwd ? `, ${running.cwd}` : ''}). `
    + 'Close it there first: two Claude processes on one session would both write its history.',
  );
}

type StartingWindow ={ pane: AgentPane; registration: Promise<PaneSession> };

/** One launch per session at a time: the chat and the terminal tab may both ask for the same window. */
const startingWindows = new Map<string, Promise<StartingWindow>>();

async function launchAgentWindow(appSessionId: string): Promise<StartingWindow> {
  const session = sessionsDb.getSessionById(appSessionId);
  if (!session) {
    throw new AgentWindowError(`Session ${appSessionId} not found.`);
  }
  if (!(await tmuxService.hasSession())) {
    throw new AgentWindowError(`tmux session "${getAgentConfig().tmuxSession}" is not running.`);
  }

  const config = getAgentConfig();
  let providerSessionId = session.provider_session_id;
  const isNewConversation = !providerSessionId;
  if (providerSessionId) {
    assertNotOpenElsewhere(await findSessionHolders(providerSessionId, config));
  }
  if (!providerSessionId) {
    providerSessionId = randomUUID();
    sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
  }

  const cwd = toLocalPath(session.project_path ?? '', config) || process.env.HOME || '/';
  writeHookSettings(config);
  const launch = buildAgentLaunch(config, isNewConversation ? { newSessionId: providerSessionId } : { resumeSessionId: providerSessionId });
  const pane = await tmuxService.newWindow({
    cwd,
    name: await uniqueWindowName(path.basename(cwd) || 'claude'),
    command: launch.command,
    env: launch.env,
  });

  const expectedSessionId = providerSessionId;
  const registration = waitForRegistration(appSessionId, pane.paneId).then((registered) => {
    if (registered.providerSessionId && registered.providerSessionId !== expectedSessionId) {
      // Claude may start a new transcript on resume; follow it so the chat keeps tracking this window.
      sessionsDb.assignProviderSessionId(appSessionId, registered.providerSessionId);
    }
    return registered;
  });
  return { pane, registration };
}

/**
 * The session's Claude window as soon as it exists, starting one if needed:
 * `--resume` for a session Claude already knows, `--session-id` with a fresh
 * id for a new app session (so the transcript is known before it exists).
 * Registration (the SessionStart hook) may still be pending — e.g. behind the
 * folder-trust dialog — which is what a terminal viewer wants to see.
 */
export async function startAgentWindow(appSessionId: string): Promise<StartingWindow> {
  const existing = await findAgentWindow(appSessionId);
  if (existing) {
    return { pane: existing.pane, registration: Promise.resolve(existing) };
  }

  let starting = startingWindows.get(appSessionId);
  if (!starting) {
    starting = launchAgentWindow(appSessionId).then((window) => {
      const registration = window.registration.finally(() => startingWindows.delete(appSessionId));
      // Callers that only want the pane must not see an unhandled rejection from a failed start.
      registration.catch(() => undefined);
      return { pane: window.pane, registration };
    });
    starting.catch(() => startingWindows.delete(appSessionId));
    startingWindows.set(appSessionId, starting);
  }
  return starting;
}

/** The session's registered Claude window, starting and waiting for one if needed. */
export async function ensureAgentWindow(appSessionId: string): Promise<PaneSession> {
  return (await startAgentWindow(appSessionId)).registration;
}

/** Epoch ms at which a local process started, from /proc (null where there is no procfs). */
async function localProcessStartedAt(pid: number): Promise<number | null> {
  try {
    const [stat, systemStat] = await Promise.all([fsp.readFile(`/proc/${pid}/stat`, 'utf8'), fsp.readFile('/proc/stat', 'utf8')]);
    const bootSeconds = Number(/^btime (\d+)$/m.exec(systemStat)?.[1]);
    // Fields after the parenthesised command name; starttime is the 20th of them, in clock ticks since boot.
    const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(bootSeconds) && Number.isFinite(startTicks) ? bootSeconds * 1000 + (startTicks * 1000) / CLOCK_TICKS_PER_SECOND : null;
  } catch {
    return null;
  }
}

/**
 * The Claude processes holding the session that are NOT the one in its tmux
 * window. A Windows claude.exe in a pane cannot be matched by pid (the pane
 * holds the interop process), so the pane's process start time is matched to
 * the process whose status file reports the closest start. Null when the pane's
 * process cannot be identified: then nothing may be stopped.
 */
export function pickProcessesOutsideTmux(processes: ClaudeProcess[], paneStartedAt: number | null): ClaudeProcess[] | null {
  if (paneStartedAt === null) {
    return null;
  }
  let paneProcess: ClaudeProcess | null = null;
  for (const candidate of processes) {
    const distance = candidate.startedAt === null ? Infinity : Math.abs(candidate.startedAt - paneStartedAt);
    if (distance <= PANE_PROCESS_MATCH_MS && (!paneProcess || distance < Math.abs((paneProcess.startedAt ?? 0) - paneStartedAt))) {
      paneProcess = candidate;
    }
  }
  return paneProcess ? processes.filter((candidate) => candidate !== paneProcess) : null;
}

async function stopClaudeProcess(claude: ClaudeProcess): Promise<void> {
  if (!claude.windowsPid) {
    process.kill(claude.pid, 'SIGTERM');
    return;
  }
  await new Promise<void>((resolve, reject) => {
    // /T: its own children (hung shells, MCP servers) go with it instead of lingering as orphans.
    execFile(TASKKILL, ['/PID', String(claude.pid), '/T', '/F'], { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Moves a session that Claude runs outside tmux (a Windows console, another
 * terminal) into its tmux window: the outside process is ended — only while it
 * is idle, so no turn is cut off — and the session is resumed in tmux (or the
 * tmux copy that already exists is kept).
 */
export async function moveSessionToTmux(appSessionId: string, options: { force?: boolean } = {}): Promise<PaneSession> {
  const session = sessionsDb.getSessionById(appSessionId);
  const providerSessionId = session?.provider_session_id;
  if (!providerSessionId) {
    throw new AgentWindowError('This session has no Claude conversation yet.');
  }

  const pane = await findAgentWindow(appSessionId);
  const holders = await findSessionHolders(providerSessionId);
  const outside = pane
    ? pickProcessesOutsideTmux(holders, await localProcessStartedAt(pane.pane.panePid))
    : holders;
  if (!outside) {
    throw new AgentWindowError('Could not tell which Claude process belongs to the tmux window; close the other one by hand.');
  }
  const working = outside.find((claude) => claude.activity !== 'idle');
  if (working && !options.force) {
    throw new AgentBusyElsewhereError(working);
  }

  for (const claude of outside) {
    await stopClaudeProcess(claude);
  }
  const stoppedPids = new Set(outside.map((claude) => claude.pid));
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (stoppedPids.size > 0 && Date.now() < deadline) {
    const alive = new Set((await readClaudeProcesses()).map((claude) => claude.pid));
    if (![...stoppedPids].some((pid) => alive.has(pid))) {
      break;
    }
    await delay(POLL_MS);
  }

  return pane ?? ensureAgentWindow(appSessionId);
}

const CLEAR_TIMEOUT_MS = 30_000;

/**
 * Runs `/clear` in the session's window: the same Claude process starts a new
 * conversation (a new session id) and the old one stays in history. Resolves
 * with the window as it reports the new conversation through the hook.
 */
export async function clearAgentConversation(appSessionId: string): Promise<PaneSession> {
  const pane = await findAgentWindow(appSessionId);
  if (!pane) {
    throw new AgentWindowError('This session has no Claude window to clear.');
  }
  const previousSessionId = pane.providerSessionId;
  await waitForInputReady(appSessionId, pane.pane.paneId);
  await typeIntoAgent(pane.pane.paneId, '/clear');

  const deadline = Date.now() + CLEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = (await paneRegistry.refresh())
      .find((candidate) => candidate.pane.paneId === pane.pane.paneId && candidate.registered);
    if (current?.providerSessionId && current.providerSessionId !== previousSessionId) {
      return current;
    }
    await delay(POLL_MS);
  }
  throw new AgentWindowError('Claude did not start a new conversation after /clear.');
}

/** Waits until the input box accepts text; menus shown meanwhile are surfaced for the user to answer. */
export async function waitForInputReady(appSessionId: string, paneId: string): Promise<void> {
  const monitor = getSessionMonitor();
  const deadline = Date.now() + INPUT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await monitor.isInputReady(paneId)) {
      return;
    }
    const prompt = await monitor.readPrompt(paneId);
    if (prompt) {
      monitor.announcePrompt(appSessionId, prompt);
    }
    await delay(POLL_MS);
  }
  throw new AgentWindowError('Claude is not accepting input (no input box on screen after 60s).');
}

async function waitForInputBox(
  paneId: string,
  isWanted: (box: InputBox | null) => boolean,
  timeoutMs: number,
): Promise<{ box: InputBox | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = readInputBox(await tmuxService.capturePane(paneId));
    if (isWanted(box)) {
      return { box };
    }
    await delay(INPUT_POLL_MS);
  }
  return null;
}

const withoutWhitespace = (text: string) => text.replace(/\s+/g, '');

/**
 * Pastes the text and presses Enter until Claude takes it. A fixed pause is not
 * enough: the TUI absorbs a paste at its own pace ("Pasting…"), and a just-started
 * Claude has dropped the Enter, leaving the message unsent in its input box.
 * Taken means the pasted text left the box: it may be empty then, or show the
 * "edit queued messages" hint while Claude is busy.
 */
export async function typeIntoAgent(paneId: string, text: string): Promise<void> {
  await tmuxService.pasteText(paneId, text);
  const landed = await waitForInputBox(paneId, (box) => Boolean(box?.text) && !box?.pasting, PASTE_LANDING_TIMEOUT_MS);
  const pastedText = withoutWhitespace(landed?.box?.text ?? '');
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    await tmuxService.sendKeys(paneId, ['Enter']);
    const submitted = await waitForInputBox(
      paneId,
      (box) => box === null || (!box.pasting && withoutWhitespace(box.text) !== pastedText),
      SUBMIT_CONFIRM_TIMEOUT_MS,
    );
    if (submitted) {
      return;
    }
  }
  throw new AgentWindowError('Claude kept the message in its input box instead of sending it.');
}

/**
 * Ends the session's Claude: its tmux window, or — when it runs in another
 * terminal — that process (only while idle, unless forced). The conversation
 * itself stays and can be resumed.
 */
export async function closeAgentWindow(appSessionId: string, options: { force?: boolean } = {}): Promise<boolean> {
  const providerSessionId = sessionsDb.getSessionById(appSessionId)?.provider_session_id ?? null;
  const pane = await findAgentWindow(appSessionId);
  if (!pane) {
    const outside = providerSessionId ? await findSessionHolders(providerSessionId) : [];
    const working = outside.find((claude) => claude.activity !== 'idle');
    if (working && !options.force) {
      throw new AgentBusyElsewhereError(working);
    }
    for (const claude of outside) {
      await stopClaudeProcess(claude);
    }
    await waitUntilNoProcessHolds(providerSessionId);
    return outside.length > 0;
  }
  try {
    await tmuxService.killWindow(pane.pane.windowId);
  } catch (error) {
    if (!(error instanceof TmuxError)) {
      throw error;
    }
  }
  await waitUntilNoProcessHolds(providerSessionId);
  return true;
}

const PROCESS_GONE_TIMEOUT_MS = 5000;

/**
 * Claude exits a moment after its window is killed, and its status file stays
 * behind. Until the process is gone it would read as a session still running
 * somewhere else, so callers that list agents right after a close wait here.
 */
async function waitUntilNoProcessHolds(providerSessionId: string | null): Promise<void> {
  if (!providerSessionId) {
    return;
  }
  const deadline = Date.now() + PROCESS_GONE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    forgetWindowsProcessCache();
    const holders = (await readClaudeProcesses()).filter((claude) => claude.providerSessionId === providerSessionId);
    if (holders.length === 0) {
      return;
    }
    await delay(POLL_MS);
  }
}
