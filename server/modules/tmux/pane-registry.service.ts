import fsp from 'node:fs/promises';
import path from 'node:path';

import { getAgentConfig, type AgentConfig } from '@/modules/tmux/agent-config.js';
import { PANES_DIRECTORY } from '@/modules/tmux/agent-launch.js';
import { tmuxService, type AgentPane, type TmuxService } from '@/modules/tmux/tmux.service.js';
import { toClaudePath, toLocalPath } from '@/modules/tmux/path-translation.js';

export type PaneSession = {
  pane: AgentPane;
  providerSessionId: string | null;
  /** Local (server-side) path of the session transcript. */
  transcriptPath: string | null;
  /** Local path of the pane's working directory. */
  cwd: string;
  /** True when the SessionStart hook reported this pane; false for a guessed (fallback) mapping. */
  registered: boolean;
};

type HookPayload = { session_id?: unknown; transcript_path?: unknown; cwd?: unknown };

const CLAUDE_PANE_COMMAND = /claude/i;

export function paneRegistryKey(pane: Pick<AgentPane, 'paneId' | 'panePid'>): string {
  return `${pane.paneId.replace(/^%/, '')}-${pane.panePid}`;
}

/** Claude names a project directory after its cwd with every non-alphanumeric character replaced by '-'. */
export function encodeClaudeProjectDirectory(claudeCwd: string): string {
  return claudeCwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function readHookPayload(filePath: string): Promise<HookPayload | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as HookPayload;
  } catch {
    return null;
  }
}

async function newestTranscriptIn(directory: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let newest: { filePath: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    const filePath = path.join(directory, name);
    try {
      const { mtimeMs } = await fsp.stat(filePath);
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { filePath, mtimeMs };
      }
    } catch {
      // Deleted between readdir and stat.
    }
  }
  return newest?.filePath ?? null;
}

export function createPaneRegistry(deps: { tmux: TmuxService; config?: () => AgentConfig }) {
  const config = deps.config ?? getAgentConfig;
  const panesDirectory = () => path.join(config().stateDir, PANES_DIRECTORY);

  async function removeStaleFiles(livePaneKeys: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(panesDirectory());
    } catch {
      return;
    }
    await Promise.all(names
      .filter((name) => name.endsWith('.json') && !livePaneKeys.has(name.slice(0, -'.json'.length)))
      .map((name) => fsp.rm(path.join(panesDirectory(), name), { force: true })));
  }

  async function resolvePane(pane: AgentPane): Promise<PaneSession | null> {
    const payload = await readHookPayload(path.join(panesDirectory(), `${paneRegistryKey(pane)}.json`));
    if (payload && typeof payload.session_id === 'string') {
      return {
        pane,
        providerSessionId: payload.session_id,
        transcriptPath: typeof payload.transcript_path === 'string' ? toLocalPath(payload.transcript_path, config()) : null,
        cwd: typeof payload.cwd === 'string' ? toLocalPath(payload.cwd, config()) : pane.cwd,
        registered: true,
      };
    }

    if (!CLAUDE_PANE_COMMAND.test(pane.command)) {
      return null;
    }

    // Claude started without our hook (e.g. by hand): best guess is the most recently written transcript for its cwd.
    const projectDirectory = path.join(
      config().claudeHome,
      'projects',
      encodeClaudeProjectDirectory(toClaudePath(pane.cwd, config())),
    );
    const transcriptPath = await newestTranscriptIn(projectDirectory);
    return {
      pane,
      providerSessionId: transcriptPath ? path.basename(transcriptPath, '.jsonl') : null,
      transcriptPath,
      cwd: pane.cwd,
      registered: false,
    };
  }

  const registry = {
    async refresh(): Promise<PaneSession[]> {
      const panes = (await deps.tmux.listPanes()).filter((pane) => !pane.dead);
      await removeStaleFiles(new Set(panes.map(paneRegistryKey)));
      const sessions = await Promise.all(panes.map(resolvePane));
      return sessions.filter((session): session is PaneSession => session !== null);
    },

    async findPaneForSession(providerSessionId: string): Promise<PaneSession | null> {
      const sessions = await registry.refresh();
      // A hook-registered pane is authoritative over a guessed one for the same session.
      return sessions.find((session) => session.providerSessionId === providerSessionId && session.registered)
        ?? sessions.find((session) => session.providerSessionId === providerSessionId)
        ?? null;
    },

    async waitForRegistration(paneId: string, timeoutMs: number): Promise<PaneSession | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sessions = await registry.refresh();
        const match = sessions.find((session) => session.pane.paneId === paneId && session.registered);
        if (match) {
          return match;
        }
        const panes = await deps.tmux.listPanes();
        if (!panes.some((pane) => pane.paneId === paneId && !pane.dead)) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return null;
    },
  };

  return registry;
}

export type PaneRegistry = ReturnType<typeof createPaneRegistry>;

export const paneRegistry = createPaneRegistry({ tmux: tmuxService });
