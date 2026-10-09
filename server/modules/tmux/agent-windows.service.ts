import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { buildAgentLaunch, writeHookSettings } from '@/modules/tmux/agent-launch.js';
import { paneRegistry, type PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { toLocalPath } from '@/modules/tmux/path-translation.js';
import { getSessionMonitor } from '@/modules/tmux/session-monitor.service.js';
import { tmuxService, TmuxError } from '@/modules/tmux/tmux.service.js';

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
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const registered = await paneRegistry.waitForRegistration(paneId, POLL_MS * 3);
    if (registered) {
      getSessionMonitor().announcePrompt(appSessionId, null);
      return registered;
    }
    const alive = (await tmuxService.listPanes()).some((pane) => pane.paneId === paneId && !pane.dead);
    if (!alive) {
      throw new AgentWindowError('Claude exited right after starting. Open the terminal tab to see why.');
    }
    getSessionMonitor().announcePrompt(appSessionId, await getSessionMonitor().readPrompt(paneId));
  }
  throw new AgentWindowError('Claude did not finish starting within 2 minutes.');
}

export async function findAgentWindow(appSessionId: string): Promise<PaneSession | null> {
  return getSessionMonitor().findPane(appSessionId);
}

/**
 * Returns the tmux pane running the session's Claude, starting one if needed:
 * `--resume` for a session Claude already knows, `--session-id` with a fresh
 * id for a new app session (so the transcript is known before it exists).
 */
export async function ensureAgentWindow(appSessionId: string): Promise<PaneSession> {
  const session = sessionsDb.getSessionById(appSessionId);
  if (!session) {
    throw new AgentWindowError(`Session ${appSessionId} not found.`);
  }
  if (!(await tmuxService.hasSession())) {
    throw new AgentWindowError(`tmux session "${getAgentConfig().tmuxSession}" is not running.`);
  }

  const existing = await findAgentWindow(appSessionId);
  if (existing) {
    return existing;
  }

  const config = getAgentConfig();
  let providerSessionId = session.provider_session_id;
  const isNewConversation = !providerSessionId;
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

  const registered = await waitForRegistration(appSessionId, pane.paneId);
  if (registered.providerSessionId && registered.providerSessionId !== providerSessionId) {
    // Claude may start a new transcript on resume; follow it so the chat keeps tracking this window.
    sessionsDb.assignProviderSessionId(appSessionId, registered.providerSessionId);
  }
  return registered;
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
