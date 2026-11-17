import { setTimeout as delay } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { quoteForShell } from '@/modules/tmux/agent-launch.js';
import { AgentWindowError } from '@/modules/tmux/agent-windows.service.js';
import { getCodexCliConfig } from '@/modules/tmux/codex-cli.js';
import { connectCodexDaemon } from '@/modules/tmux/codex-app-server.js';
import { listLockedCodexThreads } from '@/modules/tmux/codex-thread-locks.js';
import { toLocalPath, toClaudePath } from '@/modules/tmux/path-translation.js';
import { tmuxService, type AgentPane } from '@/modules/tmux/tmux.service.js';
import type { AnyRecord } from '@/shared/index.js';

const nativeIdOption = '@agentharbor-codex-thread';
const starting = new Map<string, ReturnType<typeof openWindow>>();
export const toNativeCodexPath = (value: string) => toClaudePath(value, getCodexCliConfig().pathConfig);
const windowName = (appId: string) => `codex-${appId}`;

export async function findCodexWindow(appId: string) {
  const row = sessionsDb.getSessionById(appId);
  if (row?.provider !== 'codex' || !row.provider_session_id) return null;
  const pane = (await tmuxService.listPanes()).find((entry) => !entry.dead && entry.windowName === windowName(appId));
  if (!pane || await tmuxService.readWindowOption(pane.windowId, nativeIdOption) !== row.provider_session_id) return null;
  return { pane, providerSessionId: row.provider_session_id };
}

async function openWindow(appId: string, attachSharedThread: boolean) {
  const existing = await findCodexWindow(appId);
  if (existing) return existing;
  const row = sessionsDb.getSessionById(appId);
  if (row?.provider !== 'codex') throw new AgentWindowError('Codex session was not found.');
  if (!await tmuxService.hasSession()) throw new AgentWindowError(`tmux session "${getAgentConfig().tmuxSession}" is not running.`);
  const cwd = toLocalPath(row.project_path || process.cwd(), getCodexCliConfig().pathConfig);
  const client = await connectCodexDaemon(true);
  try {
    if (row.provider_session_id && !attachSharedThread) {
      const current = await client.request('thread/read', { threadId: row.provider_session_id, includeTurns: false });
      if (current.thread?.status?.type && current.thread.status.type !== 'notLoaded') {
        throw new AgentWindowError('This Codex session is open in another client. Attach its terminal before sending a message.');
      }
    }
    // Codex itself atomically denies resume when a different app-server owns the thread writer lock.
    const nativeCwd = toNativeCodexPath(cwd);
    const config = row.provider_session_id ? null : (await client.request('config/read', { cwd: nativeCwd })).config;
    const result = row.provider_session_id
      ? await client.request('thread/resume', { threadId: row.provider_session_id, excludeTurns: true })
      : await client.request('thread/start', { cwd: nativeCwd,
        ...(config?.sandbox_mode ? { sandbox: config.sandbox_mode === 'read-only' ? 'read-only' : 'workspace-write' } : {}),
        approvalPolicy: config?.approval_policy ?? 'on-request',
        ...(row.model && row.model !== 'default' ? { model: row.model } : {}),
        ...(row.effort && row.effort !== 'default' ? { config: { model_reasoning_effort: row.effort } } : {}),
      });
    const threadId = result.thread?.id;
    if (typeof threadId !== 'string' || !threadId || (row.provider_session_id && row.provider_session_id !== threadId)) {
      throw new AgentWindowError('Codex returned a different thread than the requested session.');
    }
    if (!row.provider_session_id) {
      // Empty threads have no rollout for the TUI's resume picker until Codex persists the first metadata.
      await client.request('thread/name/set', { threadId, name: row.custom_name?.trim() || 'Codex session' });
      sessionsDb.assignProviderSessionId(appId, threadId);
    }
    const { executable, env } = getCodexCliConfig();
    const pane = await tmuxService.newWindow({
      cwd, name: windowName(appId),
      command: `exec ${[executable, '--remote', 'unix://', 'resume', threadId].map(quoteForShell).join(' ')}`,
      env: { TERM: 'xterm-256color', ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
        ...(env.WSLENV ? { WSLENV: env.WSLENV } : {}) },
    });
    await tmuxService.setWindowOption(pane.windowId, nativeIdOption, threadId);
    return { pane, providerSessionId: threadId };
  } catch (error) {
    throw new AgentWindowError(error instanceof Error ? error.message : String(error));
  } finally { client.close(); }
}

export async function ensureCodexWindow(appId: string, attachSharedThread = true) {
  const previous = starting.get(appId);
  if (previous) return previous;
  const launch = openWindow(appId, attachSharedThread).finally(() => starting.delete(appId));
  starting.set(appId, launch);
  return launch;
}

export async function waitForCodexPrompt(pane: AgentPane) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lines = (await tmuxService.capturePane(pane.paneId)).filter((line) => line.trim());
    // Codex reports the thread idle even during TUI onboarding. Its composer sits flush left above
    // the status line. Selection dialogs use indented, numbered rows and require a human response.
    if (lines.slice(-3).some((line) => /^›(?:\s+(?!\d+[.)]\s)|$)/u.test(line))) return;
    await delay(200);
  }
  throw new AgentWindowError('Open the Codex terminal to complete sign-in, review its prompt, or confirm project trust before sending.');
}

export async function closeCodexWindow(appId: string) {
  const owned = await findCodexWindow(appId);
  if (!owned) return false;
  await tmuxService.killWindow(owned.pane.windowId);
  return true;
}

type LiveThread = { providerSessionId: string; activity: 'idle' | 'waiting' | 'working' | 'unknown'; pane: AgentPane | null };
let snapshot: { expires: number; promise: Promise<LiveThread[]> } | null = null;

async function queryLiveThreads(): Promise<LiveThread[]> {
  const panesByThread = new Map<string, AgentPane>();
  const panes = (await tmuxService.listPanes()).filter((pane) => !pane.dead && pane.windowName.startsWith('codex-'));
  await Promise.all(panes.map(async (pane) => {
    const thread = await tmuxService.readWindowOption(pane.windowId, nativeIdOption);
    if (thread) panesByThread.set(thread, pane);
  }));
  const locks = await listLockedCodexThreads();
  const live = new Map<string, LiveThread>();
  for (const id of new Set([...locks, ...panesByThread.keys()])) {
    live.set(id, { providerSessionId: id, activity: 'unknown', pane: panesByThread.get(id) ?? null });
  }
  const client = await connectCodexDaemon().catch(() => null);
  if (!client) return [...live.values()];
  try {
    let cursor: string | null = null;
    do {
      const page: AnyRecord = await client.request('thread/loaded/list', { cursor, limit: 100 });
      const entries = await Promise.all((page.data as string[]).map(async (id) => {
        const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false }).catch(() => ({ thread: null }));
        if (thread?.parentThreadId || thread?.ephemeral) { live.delete(id); return null; }
        if (!thread || thread.status?.type === 'notLoaded') return null;
        const activity: LiveThread['activity'] = thread.status?.type === 'active'
          ? thread.status.activeFlags?.length ? 'waiting' : 'working' : thread.status?.type === 'idle' ? 'idle' : 'unknown';
        return { providerSessionId: id, activity, pane: panesByThread.get(id) ?? null };
      }));
      for (const entry of entries) if (entry) live.set(entry.providerSessionId, entry);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return [...live.values()];
  } finally { client.close(); }
}

export function listCodexLiveThreads(): Promise<LiveThread[]> {
  if (!snapshot || snapshot.expires <= Date.now()) {
    snapshot = { expires: Infinity, promise: queryLiveThreads().finally(() => {
      if (snapshot) snapshot.expires = Date.now() + 2000;
    }) };
  }
  return snapshot.promise;
}
