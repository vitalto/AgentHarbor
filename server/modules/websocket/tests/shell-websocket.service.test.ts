import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import test from 'node:test';

import { WebSocket } from 'ws';

import type { AgentPane, PaneSession } from '@/modules/tmux/index.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  return {
    killed: false,
    written: [] as string[],
    resized: [] as Array<[number, number]>,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit() {
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    write(data: string) {
      this.written.push(data);
    },
    resize(cols: number, rows: number) {
      this.resized.push([cols, rows]);
    },
    kill() {
      this.killed = true;
    },
  };
}

function pane(windowId: string, windowName: string, overrides: Partial<AgentPane> = {}): AgentPane {
  return { windowId, windowName, paneId: `%${windowId.slice(1)}`, panePid: 1, cwd: '/work', dead: false, command: 'bash', currentCommand: 'bash', ...overrides };
}

type SpawnCall = { file: string; args: string[]; options: { cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv } };

function createHarness(overrides: {
  ensureAgentWindow?: (appSessionId: string) => Promise<PaneSession>;
  hasSession?: boolean;
  panes?: AgentPane[];
  viewers?: number;
} = {}) {
  const killedWindows: string[] = [];
  const spawns: SpawnCall[] = [];
  const ptys: Array<ReturnType<typeof createFakePty>> = [];
  const newWindows: Array<{ cwd: string; name: string; command: string }> = [];
  const tmux = {
    ensureAgentWindow: overrides.ensureAgentWindow ?? (async (appSessionId: string): Promise<PaneSession> => ({
      pane: pane('@5', 'project', { cwd: '/mnt/d/Develop/X' }),
      providerSessionId: `provider-${appSessionId}`,
      transcriptPath: null,
      cwd: '/mnt/d/Develop/X',
      registered: true,
    })),
    hasSession: async () => overrides.hasSession ?? true,
    listPanes: async () => overrides.panes ?? [],
    newWindow: async (input: { cwd: string; name: string; command: string }) => {
      newWindows.push(input);
      return pane('@9', input.name, { cwd: input.cwd });
    },
    sessionName: () => 'main',
    socketArgs: () => [] as string[],
    countViewers: async () => overrides.viewers ?? 0,
    killWindow: async (windowId: string) => void killedWindows.push(windowId),
  };
  const dependencies = {
    tmux,
    spawnPty: ((file: string, args: string[] | string, options: SpawnCall['options']) => {
      spawns.push({ file, args: args as string[], options });
      const fakePty = createFakePty();
      ptys.push(fakePty);
      return fakePty as never;
    }) as never,
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  return { socket, spawns, ptys, newWindows, killedWindows };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function viewerArgsFor(windowId: string, viewerName: string): string[] {
  return [
    '-u',
    'new-session', '-t', 'main', '-s', viewerName,
    ';', 'set-option', 'destroy-unattached', 'on',
    ';', 'select-window', '-t', windowId,
  ];
}

test('a session terminal attaches a grouped tmux viewer to the session window', async () => {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  delete process.env.TMUX;
  process.env.TMUX_PANE = '%1';
  try {
    const { socket, spawns } = createHarness();
    socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1', projectPath: '/ignored', cols: 120, rows: 40 }));
    await settle();

    assert.equal(spawns.length, 1);
    const [spawn] = spawns;
    assert.equal(spawn.file, 'tmux');
    const viewerName = spawn.args[5];
    assert.match(viewerName, /^ah-v-[0-9a-f]+$/);
    assert.deepEqual(spawn.args, viewerArgsFor('@5', viewerName));
    assert.equal(spawn.options.cols, 120);
    assert.equal(spawn.options.rows, 40);
    assert.equal(spawn.options.cwd, os.homedir());
    assert.equal(spawn.options.env?.TMUX_PANE, undefined);
    assert.equal(spawn.options.env?.TERM, 'xterm-256color');
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousTmuxPane;
  }
});

test('the viewer never inherits TMUX (nested tmux refuses to start)', async () => {
  const previousTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
  try {
    const { socket, spawns } = createHarness();
    socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1' }));
    await settle();

    assert.equal(spawns[0].options.env?.TMUX, undefined);
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
  }
});

test('a plain shell opens a login-shell window named after the project and attaches to it', async () => {
  const { socket, spawns, newWindows } = createHarness();
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: '/mnt/d/Develop/AgentHarbor', isPlainShell: true, sessionId: null }));
  await settle();

  assert.equal(newWindows.length, 1);
  assert.equal(newWindows[0].name, 'sh:AgentHarbor');
  assert.equal(newWindows[0].cwd, '/mnt/d/Develop/AgentHarbor');
  assert.match(newWindows[0].command, /\$\{SHELL:-\/bin\/bash\}" -l/);
  assert.deepEqual(spawns[0].args, viewerArgsFor('@9', spawns[0].args[5]));
});

test('a plain shell reuses the project shell window that is still alive', async () => {
  const { socket, spawns, newWindows } = createHarness({
    panes: [pane('@3', 'sh:AgentHarbor', { dead: true }), pane('@4', 'sh:AgentHarbor')],
  });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: '/mnt/d/Develop/AgentHarbor', isPlainShell: true }));
  await settle();

  assert.equal(newWindows.length, 0);
  assert.deepEqual(spawns[0].args, viewerArgsFor('@4', spawns[0].args[5]));
});

test('a session whose window cannot be opened gets an error frame and no viewer', async () => {
  const { socket, spawns } = createHarness({
    ensureAgentWindow: async () => {
      throw new Error('Session missing-1 not found.');
    },
  });
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'missing-1' }));
  await settle();

  assert.equal(spawns.length, 0);
  assert.deepEqual(socket.frames, [{ type: 'error', message: 'Session missing-1 not found.' }]);
});

test('a plain shell without a running tmux session gets an error frame', async () => {
  const { socket, spawns } = createHarness({ hasSession: false });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: '/work', isPlainShell: true }));
  await settle();

  assert.equal(spawns.length, 0);
  assert.equal(socket.frames[0].type, 'error');
  assert.match(String(socket.frames[0].message), /tmux session "main" is not running/);
});

test('an unsafe session id is rejected before tmux is touched', async () => {
  let ensureCalls = 0;
  const { socket, spawns } = createHarness({
    ensureAgentWindow: async () => {
      ensureCalls += 1;
      throw new Error('unreachable');
    },
  });
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'bad id;rm' }));
  await settle();

  assert.equal(ensureCalls, 0);
  assert.equal(spawns.length, 0);
  assert.deepEqual(socket.frames, [{ type: 'error', message: 'Invalid session ID' }]);
});

test('viewer output, input and resize are relayed', async () => {
  const { socket, ptys } = createHarness();
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1' }));
  await settle();

  ptys[0].emitData('live screen');
  socket.emit('message', JSON.stringify({ type: 'input', data: 'ls\r' }));
  socket.emit('message', JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

  assert.deepEqual(socket.frames, [{ type: 'output', data: 'live screen' }]);
  assert.deepEqual(ptys[0].written, ['ls\r']);
  assert.deepEqual(ptys[0].resized, [[100, 30]]);
});

test('a viewer that cannot be spawned is reported as an error frame', async () => {
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    tmux: {
      ensureAgentWindow: async () => ({ pane: pane('@5', 'project'), providerSessionId: null, transcriptPath: null, cwd: '/work', registered: true }),
      sessionName: () => 'main',
      socketArgs: () => [],
    } as never,
    spawnPty: (() => {
      throw new Error('posix_spawnp failed.');
    }) as never,
  });
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1' }));
  await settle();

  assert.deepEqual(socket.frames, [{ type: 'error', message: 'posix_spawnp failed.' }]);
});

test('closing the socket kills the viewer immediately', async () => {
  const { socket, ptys } = createHarness();
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1' }));
  await settle();

  socket.emit('close');

  assert.equal(ptys[0].killed, true);
});

test('a socket closed while the window is being opened never spawns a viewer', async () => {
  let openWindow: (session: PaneSession) => void = () => undefined;
  const { socket, spawns } = createHarness({
    ensureAgentWindow: () => new Promise<PaneSession>((resolve) => {
      openWindow = resolve;
    }),
  });
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1' }));
  await settle();
  socket.emit('close');
  openWindow({ pane: pane('@5', 'project'), providerSessionId: null, transcriptPath: null, cwd: '/work', registered: true });
  await settle();

  assert.equal(spawns.length, 0);
});

const afterViewerDetach = () => new Promise((resolve) => setTimeout(resolve, 600));

test('closing the tab closes its project shell window when the shell is idle and nobody else watches', async () => {
  const shellWindow = pane('@4', 'sh:AgentHarbor');
  const { socket, killedWindows } = createHarness({ panes: [shellWindow] });
  socket.emit('message', JSON.stringify({ type: 'init', projectPath: '/mnt/d/Develop/AgentHarbor', isPlainShell: true, sessionId: null }));
  await settle();
  socket.emit('close');
  await afterViewerDetach();
  assert.deepEqual(killedWindows, ['@4']);
});

test('a project shell running something, or watched elsewhere, stays open', async () => {
  const busy = createHarness({ panes: [pane('@4', 'sh:AgentHarbor', { currentCommand: 'npm' })] });
  busy.socket.emit('message', JSON.stringify({ type: 'init', projectPath: '/mnt/d/Develop/AgentHarbor', isPlainShell: true, sessionId: null }));
  await settle();
  busy.socket.emit('close');

  const watched = createHarness({ panes: [pane('@4', 'sh:AgentHarbor')], viewers: 1 });
  watched.socket.emit('message', JSON.stringify({ type: 'init', projectPath: '/mnt/d/Develop/AgentHarbor', isPlainShell: true, sessionId: null }));
  await settle();
  watched.socket.emit('close');

  await afterViewerDetach();
  assert.deepEqual(busy.killedWindows, []);
  assert.deepEqual(watched.killedWindows, []);
});

test('closing the tab never closes a Claude session window', async () => {
  const { socket, killedWindows } = createHarness({ panes: [pane('@5', 'project', { currentCommand: 'bash' })] });
  socket.emit('message', JSON.stringify({ type: 'init', sessionId: 'app-1' }));
  await settle();
  socket.emit('close');
  await afterViewerDetach();
  assert.deepEqual(killedWindows, []);
});
