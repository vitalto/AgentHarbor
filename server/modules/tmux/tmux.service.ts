import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { getAgentConfig } from '@/modules/tmux/agent-config.js';

export type AgentPane = {
  windowId: string;
  windowName: string;
  paneId: string;
  panePid: number;
  cwd: string;
  dead: boolean;
  /** The command the pane was started with (pane_start_command), e.g. the claude launch line. */
  command: string;
  /** What runs in the foreground right now (pane_current_command), e.g. bash or npm. */
  currentCommand: string;
};

export type TmuxService = ReturnType<typeof createTmuxService>;

// Printable on purpose: tmux 3.4 prints control characters in -F output as octal escapes ("\037").
const FIELD_SEPARATOR = '|~|';
const PANE_FORMAT = ['#{window_id}', '#{window_name}', '#{pane_id}', '#{pane_pid}', '#{pane_current_path}', '#{pane_dead}', '#{pane_start_command}', '#{pane_current_command}']
  .join(FIELD_SEPARATOR);

function parsePaneLine(line: string): AgentPane | null {
  const [windowId, windowName, paneId, panePid, cwd, dead, command, currentCommand] = line.split(FIELD_SEPARATOR);
  if (!windowId || !paneId) {
    return null;
  }
  return {
    windowId,
    windowName,
    paneId,
    panePid: Number(panePid) || 0,
    cwd: cwd ?? '',
    dead: dead === '1',
    command: command ?? '',
    currentCommand: currentCommand ?? '',
  };
}

export class TmuxError extends Error {}

function parseSize(text: string): { width: number; height: number } {
  const [width, height] = text.trim().split('x').map(Number);
  return { width: width || 0, height: height || 0 };
}

/**
 * Arguments addressing the tmux server. Without an explicit socket name, a
 * server running inside tmux follows $TMUX; spelled out as -S so processes
 * started with TMUX removed (nested viewers) reach the same server.
 */
function resolveSocketArgs(socketName: string | undefined): string[] {
  if (socketName) {
    return ['-L', socketName];
  }
  const inheritedSocketPath = process.env.TMUX?.split(',')[0];
  return inheritedSocketPath ? ['-S', inheritedSocketPath] : [];
}

/**
 * Tells the tmux client its output may be UTF-8. Without a UTF-8 locale (a bare systemd service,
 * CI) tmux prints the field separator and every non-ASCII character (Cyrillic paths) as "_".
 */
const UTF8_CLIENT_FLAG = '-u';

export function createTmuxService(options: { socketName?: string; session?: string } = {}) {
  const socketArgs = resolveSocketArgs(options.socketName);
  const sessionName = () => options.session ?? getAgentConfig().tmuxSession;

  const run = (args: string[], stdin?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile('tmux', [UTF8_CLIENT_FLAG, ...socketArgs, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new TmuxError(`tmux ${args[0]} failed: ${(stderr || error.message).trim()}`));
          return;
        }
        resolve(stdout);
      });
      if (stdin !== undefined) {
        child.stdin?.end(stdin);
      }
    });

  /** How many attached clients (any session of the group, e.g. a phone on main or another browser) show this window. */
  const countViewers = async (windowId: string): Promise<number> => {
    let output: string;
    try {
      output = await run(['list-sessions', '-F', `#{session_attached}${FIELD_SEPARATOR}#{window_id}`]);
    } catch {
      return 0;
    }
    return output.split('\n').reduce((count, line) => {
      const [attached, currentWindowId] = line.split(FIELD_SEPARATOR);
      return currentWindowId === windowId ? count + (Number(attached) || 0) : count;
    }, 0);
  };

  return {
    sessionName,

    /** Arguments that address this tmux server, for callers spawning tmux themselves (node-pty). */
    socketArgs: () => [...socketArgs],

    async hasSession(): Promise<boolean> {
      try {
        await run(['has-session', '-t', `=${sessionName()}`]);
        return true;
      } catch {
        return false;
      }
    },

    async listPanes(): Promise<AgentPane[]> {
      let output: string;
      try {
        output = await run(['list-panes', '-s', '-t', `=${sessionName()}`, '-F', PANE_FORMAT]);
      } catch {
        return [];
      }
      return output.split('\n').map(parsePaneLine).filter((pane): pane is AgentPane => pane !== null);
    },

    async newWindow(input: { cwd: string; name: string; command: string; env?: Record<string, string> }): Promise<AgentPane> {
      const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      const output = await run([
        'new-window', '-d', '-P', '-F', PANE_FORMAT,
        '-t', `=${sessionName()}:`,
        '-n', input.name,
        '-c', input.cwd,
        ...envArgs,
        input.command,
      ]);
      const pane = parsePaneLine(output.trim());
      if (!pane) {
        throw new TmuxError(`tmux new-window returned an unexpected line: ${output}`);
      }
      return pane;
    },

    countViewers,

    /**
     * With window-size=latest a window keeps the size of the last client that
     * showed it, so after a phone (ssh or the Shell tab) leaves, Claude goes on
     * drawing into 45x18 and a question menu taller than that loses its first
     * option and the question off the top. Once nobody shows the window it goes
     * back to the server's default size; the next viewer still resizes it.
     * Returns whether it resized.
     */
    async restoreShrunkWindow(windowId: string): Promise<boolean> {
      const [current, preferred] = await Promise.all([
        run(['display-message', '-p', '-t', windowId, '#{window_width}x#{window_height}']).then(parseSize),
        run(['show-options', '-gv', 'default-size']).then(parseSize),
      ]);
      const shrunk = current.width < preferred.width || current.height < preferred.height;
      if (!shrunk || (await countViewers(windowId)) > 0) {
        return false;
      }
      await run(['resize-window', '-t', windowId, '-x', String(preferred.width), '-y', String(preferred.height)]);
      // resize-window pins the window to manual sizing; unset it so viewers resize it again.
      await run(['set-option', '-wu', '-t', windowId, 'window-size']);
      return true;
    },

    async killWindow(windowId: string): Promise<void> {
      await run(['kill-window', '-t', windowId]);
    },

    async selectWindow(windowId: string): Promise<void> {
      await run(['select-window', '-t', windowId]);
    },

    /** One bracketed paste, so multi-line text reaches the TUI as a single prompt. */
    async pasteText(paneId: string, text: string): Promise<void> {
      const bufferName = `ah-${randomUUID()}`;
      await run(['load-buffer', '-b', bufferName, '-'], text);
      await run(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneId]);
    },

    async sendKeys(paneId: string, keys: string[]): Promise<void> {
      if (keys.length > 0) {
        await run(['send-keys', '-t', paneId, ...keys]);
      }
    },

    async capturePane(paneId: string): Promise<string[]> {
      const output = await run(['capture-pane', '-p', '-t', paneId]);
      return output.replace(/\n$/, '').split('\n').map((line) => line.trimEnd());
    },

    /** Starts a detached server for tests; production relies on the user's existing server. */
    async startDetachedSession(cwd: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tmux', [UTF8_CLIENT_FLAG, ...socketArgs, 'new-session', '-d', '-s', sessionName(), '-c', cwd, '-x', '200', '-y', '50']);
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new TmuxError(`new-session exited ${code}`))));
      });
    },

    async killServer(): Promise<void> {
      await run(['kill-server']).catch(() => undefined);
    },
  };
}

export const tmuxService = createTmuxService();
