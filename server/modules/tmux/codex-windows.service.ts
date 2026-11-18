import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { quoteForShell } from '@/modules/tmux/agent-launch.js';
import { AgentWindowError } from '@/modules/tmux/agent-windows.service.js';
import { getCodexCliConfig } from '@/modules/tmux/codex-cli.js';
import { isArchivedCodexRollout, recoverSessionTranscript } from '@/shared/index.js';
import { listLockedCodexThreads } from '@/modules/tmux/codex-thread-locks.js';
import { readCodexScreen, readCodexStatusThread, typeCodexInput } from '@/modules/tmux/codex-tui.js';
import { toClaudePath, toLocalPath } from '@/modules/tmux/path-translation.js';
import { tmuxService, type AgentPane } from '@/modules/tmux/tmux.service.js';

const nativeIdOption = '@agentharbor-codex-thread';
const observedIdOption = '@agentharbor-codex-current-thread';
const paneIdOption = '@agentharbor-codex-pane';
const selectionOption = '@agentharbor-codex-selection';
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const starting = new Map<string, ReturnType<typeof openWindow>>();

function titleIdPrefix(title: string) {
  if (uuid.test(title)) return title;
  return /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]+)(?:\.\.\.|…)$/i.exec(title)?.[1];
}

async function paneOwnership(pane: AgentPane) {
  if (pane.dead || !pane.windowName.startsWith('codex-')) return null;
  const readOption = (key: string) => tmuxService.readWindowOption(pane.windowId, key).catch(() => null);
  const owner = await readOption(paneIdOption);
  if (owner) return owner === pane.paneId ? { legacyThreadId: null } : null;
  // Legacy tags belong to a window; the resume command singles out its original pane after a split.
  const initial = await readOption(nativeIdOption);
  if (!initial || !uuid.test(initial)) return null;
  const resumeArgs = ['--remote', 'unix://', 'resume', initial].map(quoteForShell).join(' ');
  if (!pane.command.includes(resumeArgs)) return null;
  const observed = await readOption(observedIdOption);
  return { legacyThreadId: observed && uuid.test(observed) ? observed : initial };
}

/** Looks up the terminal for a chat without opening a new window or taking ownership of an external session. */
export async function findCodexWindow(appId: string, panes?: AgentPane[]) {
  const row = sessionsDb.getSessionById(appId);
  if (row?.provider !== 'codex') return null;
  const nativeId = row.provider_session_id;
  for (const pane of panes ?? await tmuxService.listPanes()) {
    const prefix = titleIdPrefix(pane.title ?? '');
    if (prefix && nativeId && !nativeId.startsWith(prefix)) continue;
    const owner = await paneOwnership(pane);
    if (!owner) continue;
    // /new and /resume can switch threads without renaming the tmux window.
    const matches = prefix && nativeId ? nativeId.startsWith(prefix)
      : owner.legacyThreadId ? owner.legacyThreadId === nativeId : pane.windowName === `codex-${appId}`;
    if (matches) return { pane, providerSessionId: nativeId, ...owner };
  }
  return null;
}

async function openWindow(appId: string) {
  const existing = await findCodexWindow(appId);
  if (existing) return existing;
  const row = sessionsDb.getSessionById(appId);
  if (row?.provider !== 'codex') throw new AgentWindowError('Codex session was not found.');
  const { executable, env, pathConfig } = getCodexCliConfig();
  if (!await tmuxService.hasSession()) throw new AgentWindowError(`tmux session "${pathConfig.tmuxSession}" is not running.`);
  const nativeId = row.provider_session_id;
  if (nativeId && row.jsonl_path) {
    const rollout = await recoverSessionTranscript(row.jsonl_path);
    if (rollout && isArchivedCodexRollout(rollout)) {
      throw new AgentWindowError('Restore this archived Codex session before resuming it.');
    }
  }
  if (nativeId && (await listLockedCodexThreads()).includes(nativeId)) {
    throw new AgentWindowError('Close this session in the other Codex client before resuming it in tmux.');
  }
  const cwd = toLocalPath(row.project_path || process.cwd(), pathConfig);
  const args = [
    executable, '--no-daemon', '-C', toClaudePath(cwd, pathConfig),
    '-c', 'tui.terminal_title=["session-id"]',
  ];
  const sandbox = env.AH_CODEX_SANDBOX_MODE?.trim();
  if (sandbox === 'danger-full-access') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--ask-for-approval', 'on-request', '-c', 'approvals_reviewer="auto_review"');
    if (!nativeId && sandbox) args.push('--sandbox', sandbox);
  }
  if (row.model && row.model !== 'default') args.push('--model', row.model);
  if (row.effort && row.effort !== 'default') args.push('-c', `model_reasoning_effort=${JSON.stringify(row.effort)}`);
  if (nativeId) args.push('resume', nativeId);
  const pane = await tmuxService.newWindow({
    cwd, name: `codex-${appId}`, command: `exec ${args.map(quoteForShell).join(' ')}`,
    env: { TERM: 'xterm-256color', ...(env.CODEX_HOME && { CODEX_HOME: env.CODEX_HOME }), ...(env.WSLENV && { WSLENV: env.WSLENV }) },
  });
  try {
    await tmuxService.setWindowOption(pane.windowId, paneIdOption, pane.paneId);
    await tmuxService.setWindowOption(pane.windowId, selectionOption, JSON.stringify([row.model || 'default', row.effort || 'default']));
    if (!nativeId) void registerNewTerminal(appId, pane);
    return { pane, providerSessionId: nativeId, legacyThreadId: null };
  } catch (error) {
    await tmuxService.killWindow(pane.windowId).catch(() => {});
    throw error;
  }
}

/** Opens the interactive CLI for both the Terminal tab and chat sends; concurrent opens share one launch. */
export function ensureCodexWindow(appId: string) {
  const pending = starting.get(appId);
  if (pending) return pending;
  const launch = openWindow(appId).finally(() => starting.delete(appId));
  starting.set(appId, launch);
  return launch;
}

async function threadForTitle(title: string, expected: string | null) {
  if (uuid.test(title)) return title;
  // Codex caps terminal titles at 32 characters. Its per-thread lock filenames contain the full UUID.
  const prefix = titleIdPrefix(title);
  if (!prefix) return null;
  if (expected?.startsWith(prefix)) return expected;
  const names = await readdir(path.join(getCodexCliConfig().home, 'thread-writer-locks')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = names.filter((name) => name.startsWith(prefix) && name.endsWith('.lock') && uuid.test(name.slice(0, -5)));
  return candidates.length === 1 ? candidates[0].slice(0, -5) : null;
}

async function bindScreen(appId: string, title: string) {
  const row = sessionsDb.getSessionById(appId);
  if (row?.provider !== 'codex') throw new AgentWindowError('Codex session was not found.');
  const id = await threadForTitle(title, row.provider_session_id);
  if (!id) return null;
  const current = sessionsDb.getSessionById(appId);
  if (current?.provider !== 'codex') throw new AgentWindowError('Codex session was not found.');
  if (current.provider_session_id && id !== current.provider_session_id) {
    throw new AgentWindowError('The terminal switched to a different Codex session. Open that conversation to continue.');
  }
  if (!current.provider_session_id) sessionsDb.assignProviderSessionId(appId, id);
  return id;
}

async function registerNewTerminal(appId: string, pane: AgentPane) {
  // A Terminal-only conversation must be bound even when there is no chat subscriber or active turn.
  for (;;) {
    const row = sessionsDb.getSessionById(appId);
    if (!row || row.provider_session_id) return;
    const state = await inspectCodexWindow(appId, pane).catch(() => null);
    if (!state || state.providerSessionId) return;
    await delay(500, undefined, { ref: false });
  }
}

/** Verifies the TUI title for chat input, subscriptions and the agents list, including after a server restart. */
export async function inspectCodexWindow(appId: string, pane: AgentPane) {
  const screen = await readCodexScreen(pane.paneId);
  return { screen, providerSessionId: await bindScreen(appId, screen.title) };
}

/** Waits for the real Codex composer and binds its native UUID before the chat types anything. */
export async function waitForCodexComposer(appId: string, pane: AgentPane, signal: AbortSignal, legacyThreadId: string | null) {
  if (legacyThreadId) await tmuxService.restoreShrunkWindow(pane.windowId);
  let deadline = Date.now() + 15_000;
  do {
    signal.throwIfAborted();
    const { screen, providerSessionId } = await inspectCodexWindow(appId, pane);
    if (screen.empty && providerSessionId) return { screen, providerSessionId };
    if (screen.empty && legacyThreadId && !titleIdPrefix(screen.title)) {
      if (screen.activity === 'working') throw new AgentWindowError('Wait for this Codex turn to finish before sending from chat.');
      const status = await readCodexStatusThread(pane.paneId, screen.title, signal);
      if (status.threadId !== legacyThreadId) {
        await tmuxService.setWindowOption(pane.windowId, observedIdOption, status.threadId);
      }
      if (status.threadId !== sessionsDb.getSessionById(appId)?.provider_session_id) {
        throw new AgentWindowError('The terminal switched to a different Codex session. Open that conversation to continue.');
      }
      return { screen: status.screen, providerSessionId: status.threadId };
    }
    if (screen.activity === 'waiting') deadline = Date.now() + 15_000;
    if (screen.composer && !screen.empty) throw new AgentWindowError('Finish the draft in the Codex terminal before sending.');
    await delay(150);
  } while (Date.now() < deadline);
  throw new AgentWindowError('Open Terminal to finish Codex setup or answer the dialog. For an older AgentHarbor window, close it and reopen this session.');
}

/** Applies a changed web picker selection through the CLI's session-local /model command. */
export async function applyCodexSelection(pane: AgentPane, title: string, model: string, effort: string,
  resolveDefaults: () => Promise<{ model?: string; effort?: string }>) {
  const selection = JSON.stringify([model, effort]);
  const previous = await tmuxService.readWindowOption(pane.windowId, selectionOption);
  if (previous === selection) return;
  if (!previous && model === 'default' && effort === 'default') {
    await tmuxService.setWindowOption(pane.windowId, selectionOption, selection);
    return;
  }
  const defaults = await resolveDefaults();
  const target = model === 'default' ? defaults.model : model;
  const level = effort === 'default' ? defaults.effort : effort;
  if (!target || !/^[\w./:-]+$/.test(target) || (level && !/^[\w-]+$/.test(level))) {
    throw new AgentWindowError('Codex could not resolve the selected model or reasoning effort.');
  }
  await typeCodexInput(pane.paneId, `/model ${target}${level ? ' --reasoning=' + level : ''}`, [], title);
  const deadline = Date.now() + 3000;
  do {
    const screen = await readCodexScreen(pane.paneId);
    if (screen.empty && screen.title === title) {
      const feedback = screen.lines.filter((line) => /^[■•] /.test(line)).at(-1);
      if (feedback?.startsWith('■')) throw new AgentWindowError(feedback.slice(2));
      if (feedback?.startsWith('• Model changed to ')) {
        await tmuxService.setWindowOption(pane.windowId, selectionOption, selection);
        return;
      }
    }
    await delay(75);
  } while (Date.now() < deadline);
  throw new AgentWindowError('Check the model selection in the Codex terminal before sending.');
}

/** Closes only the terminal associated with this app session. */
export async function closeCodexWindow(appId: string) {
  const owned = await findCodexWindow(appId);
  if (!owned) return false;
  await tmuxService.killWindow(owned.pane.windowId);
  return true;
}

/** Delivers reminders and retries only to an owned terminal still showing the intended, idle thread. */
export async function sendCodexRuntimePrompt(providerSessionId: string, pane: AgentPane, text: string,
  acceptIdleScreen: (screen: Awaited<ReturnType<typeof readCodexScreen>>) => boolean | Promise<boolean> = () => true): Promise<boolean> {
  const owner = await paneOwnership(pane);
  if (!owner) return false;
  const screen = await readCodexScreen(pane.paneId);
  if (screen.activity !== 'idle') return false;
  let threadId = await threadForTitle(screen.title, providerSessionId);
  if (!threadId && !titleIdPrefix(screen.title) && owner.legacyThreadId === providerSessionId) {
    const status = await readCodexStatusThread(pane.paneId, screen.title, AbortSignal.timeout(5000), true);
    threadId = status.threadId;
  }
  if (threadId !== providerSessionId) return false;
  return typeCodexInput(pane.paneId, text, [], screen.title, undefined, acceptIdleScreen);
}

type LiveThread = { providerSessionId: string; updatedAt?: number; activity: 'idle' | 'waiting' | 'working' | 'unknown'; backgroundTerminalCount?: number; pane: AgentPane | null };
let snapshot: { expires: number; promise: Promise<LiveThread[]> } | null = null;

async function queryLiveThreads(): Promise<LiveThread[]> {
  const [panes, locked] = await Promise.all([tmuxService.listPanes(), listLockedCodexThreads()]);
  const live = new Map<string, LiveThread>(locked.map((providerSessionId) => [providerSessionId, { providerSessionId, activity: 'unknown', pane: null }]));
  await Promise.all(panes.filter((pane) => !pane.dead && pane.windowName.startsWith('codex-')).map(async (pane) => {
    const appId = pane.windowName.slice('codex-'.length);
    const row = sessionsDb.getSessionById(appId);
    const owner = await paneOwnership(pane);
    if (!owner) return;
    const screen = await readCodexScreen(pane.paneId).catch(() => null);
    if (!screen) return;
    const fromTitle = row?.provider === 'codex' && !row.provider_session_id
      ? await bindScreen(appId, screen.title)
      : await threadForTitle(screen.title, row?.provider_session_id ?? null);
    const id = fromTitle ?? (!titleIdPrefix(screen.title) ? owner.legacyThreadId : null);
    if (!id) return;
    const current = sessionsDb.getSessionByProviderSessionId(id);
    live.set(id, { providerSessionId: id, activity: screen.activity, backgroundTerminalCount: screen.backgroundTerminalCount,
      pane, updatedAt: current ? Date.parse(current.updated_at) : undefined });
  }));
  return [...live.values()];
}

/** Supplies the agents list and idle reaper with owned terminals and read-only external writer locks. */
export function listCodexLiveThreads(): Promise<LiveThread[]> {
  if (!snapshot || snapshot.expires <= Date.now()) {
    snapshot = { expires: Infinity, promise: queryLiveThreads().finally(() => {
      if (snapshot) snapshot.expires = Date.now() + 2000;
    }) };
  }
  return snapshot.promise;
}
