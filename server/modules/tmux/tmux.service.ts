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
};

export type TmuxService = ReturnType<typeof createTmuxService>;

const FIELD_SEPARATOR = '\u001f';
const PANE_FORMAT = ['#{window_id}', '#{window_name}', '#{pane_id}', '#{pane_pid}', '#{pane_current_path}', '#{pane_dead}', '#{pane_start_command}']
  .join(FIELD_SEPARATOR);

function parsePaneLine(line: string): AgentPane | null {
  const [windowId, windowName, paneId, panePid, cwd, dead, command] = line.split(FIELD_SEPARATOR);
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
  };
}

export class TmuxError extends Error {}

export function createTmuxService(options: { socketName?: string; session?: string } = {}) {
  const socketArgs = options.socketName ? ['-L', options.socketName] : [];
  const sessionName = () => options.session ?? getAgentConfig().tmuxSession;

  const run = (args: string[], stdin?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile('tmux', [...socketArgs, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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
        const child = spawn('tmux', [...socketArgs, 'new-session', '-d', '-s', sessionName(), '-c', cwd, '-x', '200', '-y', '50']);
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
