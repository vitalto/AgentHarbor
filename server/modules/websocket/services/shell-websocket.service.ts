import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import {
  getAgentConfig,
  startAgentWindow,
  toLocalPath,
  tmuxService,
  type AgentPane,
} from '@/modules/tmux/index.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string | null;
  isPlainShell?: boolean;
};

type ShellTmuxGateway = {
  /** Resolves as soon as the window exists, even while Claude is still starting (trust dialog etc.). */
  ensureAgentWindow: (appSessionId: string) => Promise<{ pane: AgentPane }>;
  hasSession: () => Promise<boolean>;
  listPanes: () => Promise<AgentPane[]>;
  newWindow: (input: { cwd: string; name: string; command: string }) => Promise<AgentPane>;
  countViewers: (windowId: string) => Promise<number>;
  killWindow: (windowId: string) => Promise<void>;
  sessionName: () => string;
  socketArgs: () => string[];
};

type ShellWebSocketDependencies = {
  spawnPty?: typeof pty.spawn;
  tmux?: ShellTmuxGateway;
};

const defaultTmuxGateway: ShellTmuxGateway = {
  ensureAgentWindow: startAgentWindow,
  hasSession: () => tmuxService.hasSession(),
  listPanes: () => tmuxService.listPanes(),
  newWindow: (input) => tmuxService.newWindow(input),
  countViewers: (windowId) => tmuxService.countViewers(windowId),
  killWindow: (windowId) => tmuxService.killWindow(windowId),
  sessionName: () => tmuxService.sessionName(),
  socketArgs: () => tmuxService.socketArgs(),
};

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;
const LOGIN_SHELL_COMMAND = 'exec "${SHELL:-/bin/bash}" -l';

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  return parseIncomingJsonObject(rawMessage) as ShellIncomingMessage | null;
}

function sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

function viewerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

/**
 * A grouped session shares the windows of the agent session but has its own
 * current window, so a browser switching windows never moves another client
 * (the phone). destroy-unattached removes it as soon as this viewer detaches.
 */
function buildViewerArgs(gateway: ShellTmuxGateway, windowId: string, viewerName: string): string[] {
  return [
    ...gateway.socketArgs(),
    'new-session', '-t', gateway.sessionName(), '-s', viewerName,
    ';', 'set-option', 'destroy-unattached', 'on',
    ';', 'select-window', '-t', windowId,
  ];
}

function plainShellWindowName(projectPath: string): string {
  return `sh:${path.basename(projectPath) || 'home'}`;
}

const pendingShellWindows = new Map<string, Promise<string>>();

const VIEWER_DETACH_SETTLE_MS = 500;
const IDLE_SHELL_COMMANDS = /^-?(bash|zsh|sh|fish|dash)$/;

/**
 * A project shell window exists for the Shell tab. Once nobody looks at it and
 * nothing runs in it (the shell itself is in the foreground), it is closed so
 * such windows do not pile up in tmux; a running dev server keeps it open.
 */
async function closeShellWindowIfIdle(gateway: ShellTmuxGateway, windowId: string): Promise<void> {
  const pane = (await gateway.listPanes()).find((candidate) => candidate.windowId === windowId);
  if (!pane || !pane.windowName.startsWith('sh:') || !IDLE_SHELL_COMMANDS.test(pane.currentCommand)) {
    return;
  }
  if ((await gateway.countViewers(windowId)) > 0) {
    return;
  }
  await gateway.killWindow(windowId).catch(() => undefined);
}

/** Reuses the project's shell window so reconnecting lands in the same shell; two racing inits share one creation. */
async function ensurePlainShellWindow(gateway: ShellTmuxGateway, cwd: string): Promise<string> {
  const name = plainShellWindowName(cwd);
  const pending = pendingShellWindows.get(name);
  if (pending) {
    return pending;
  }

  const lookupOrCreate = (async () => {
    const existing = (await gateway.listPanes()).find((pane) => pane.windowName === name && !pane.dead);
    if (existing) {
      return existing.windowId;
    }
    const created = await gateway.newWindow({ cwd, name, command: LOGIN_SHELL_COMMAND });
    return created.windowId;
  })();
  pendingShellWindows.set(name, lookupOrCreate);
  try {
    return await lookupOrCreate;
  } finally {
    pendingShellWindows.delete(name);
  }
}

async function resolveTargetWindow(
  message: ShellIncomingMessage,
  gateway: ShellTmuxGateway,
): Promise<string> {
  const sessionId = readString(message.sessionId);
  if (sessionId && message.isPlainShell !== true) {
    if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('Invalid session ID');
    }
    const pane = await gateway.ensureAgentWindow(sessionId);
    return pane.pane.windowId;
  }

  if (!(await gateway.hasSession())) {
    throw new Error(`tmux session "${gateway.sessionName()}" is not running.`);
  }
  const cwd = toLocalPath(readString(message.projectPath), getAgentConfig()) || os.homedir();
  return ensurePlainShellWindow(gateway, cwd);
}

/**
 * Bridges the Shell tab to a live tmux window: each socket gets its own
 * grouped viewer session, killed as soon as the socket closes. The window
 * itself (a Claude session or a project shell) lives on in tmux.
 */
export function handleShellConnection(ws: WebSocket, dependencies: ShellWebSocketDependencies = {}): void {
  const gateway = dependencies.tmux ?? defaultTmuxGateway;
  const spawnPty = dependencies.spawnPty ?? pty.spawn;
  let viewer: IPty | null = null;
  let initGeneration = 0;
  let socketClosed = false;
  let terminalSize = { cols: 80, rows: 24 };
  let attachedWindowId: string | null = null;

  const killViewer = () => {
    const current = viewer;
    const windowId = attachedWindowId;
    viewer = null;
    attachedWindowId = null;
    current?.kill();
    if (windowId) {
      // Give tmux a moment to drop the killed viewer's session before counting who still looks.
      setTimeout(() => void closeShellWindowIfIdle(gateway, windowId).catch(() => undefined), VIEWER_DETACH_SETTLE_MS);
    }
  };

  const attachViewer = async (message: ShellIncomingMessage) => {
    initGeneration += 1;
    const generation = initGeneration;
    killViewer();
    terminalSize = { cols: readNumber(message.cols, 80), rows: readNumber(message.rows, 24) };

    let spawned: IPty;
    let windowId: string;
    try {
      windowId = await resolveTargetWindow(message, gateway);
      if (socketClosed || generation !== initGeneration) {
        return;
      }
      const viewerName = `ah-v-${randomBytes(4).toString('hex')}`;
      // The window keeps its own working directory; the viewer client only needs one that exists.
      spawned = spawnPty('tmux', buildViewerArgs(gateway, windowId, viewerName), {
        name: 'xterm-256color',
        cols: terminalSize.cols,
        rows: terminalSize.rows,
        cwd: os.homedir(),
        env: viewerEnvironment(),
      });
    } catch (error) {
      sendFrame(ws, { type: 'error', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    viewer = spawned;
    attachedWindowId = windowId;

    spawned.onData((chunk) => {
      sendFrame(ws, { type: 'output', data: chunk });
    });
    spawned.onExit(({ exitCode }) => {
      if (viewer !== spawned) {
        return;
      }
      viewer = null;
      sendFrame(ws, { type: 'output', data: `\r\n\x1b[33mtmux viewer exited (code ${exitCode})\x1b[0m\r\n` });
    });
  };

  ws.on('message', (rawMessage) => {
    const message = parseShellMessage(rawMessage);
    if (!message?.type) {
      sendFrame(ws, { type: 'error', message: 'Invalid websocket payload' });
      return;
    }

    if (message.type === 'init') {
      void attachViewer(message);
      return;
    }

    if (message.type === 'input') {
      viewer?.write(readString(message.data));
      return;
    }

    if (message.type === 'resize') {
      terminalSize = { cols: readNumber(message.cols, terminalSize.cols), rows: readNumber(message.rows, terminalSize.rows) };
      viewer?.resize(terminalSize.cols, terminalSize.rows);
    }
  });

  ws.on('close', () => {
    socketClosed = true;
    killViewer();
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
