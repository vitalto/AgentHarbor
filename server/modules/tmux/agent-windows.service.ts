import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { readClaudeStatuses, type ClaudeStatus } from '@/modules/tmux/claude-status.js';
import { buildAgentLaunch, writeHookSettings } from '@/modules/tmux/agent-launch.js';
import { paneRegistry, type PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { toLocalPath } from '@/modules/tmux/path-translation.js';
import { getSessionMonitor } from '@/modules/tmux/session-monitor.service.js';
import { tmuxService, TmuxError, type AgentPane } from '@/modules/tmux/tmux.service.js';

const REGISTRATION_TIMEOUT_MS = 120_000;
const INPUT_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 300;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AgentWindowError extends Error {}

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
export function assertNotOpenElsewhere(providerSessionId: string, statuses: Map<string, ClaudeStatus>): void {
  const running = statuses.get(providerSessionId);
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
    assertNotOpenElsewhere(providerSessionId, await readClaudeStatuses(config));
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

export async function typeIntoAgent(paneId: string, text: string): Promise<void> {
  await tmuxService.pasteText(paneId, text);
  // The TUI needs a moment to absorb a bracketed paste before Enter submits it.
  await delay(250);
  await tmuxService.sendKeys(paneId, ['Enter']);
}

export async function closeAgentWindow(appSessionId: string): Promise<boolean> {
  const pane = await findAgentWindow(appSessionId);
  if (!pane) {
    return false;
  }
  try {
    await tmuxService.killWindow(pane.pane.windowId);
  } catch (error) {
    if (!(error instanceof TmuxError)) {
      throw error;
    }
  }
  return true;
}
