import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFileSync, rm, writeFile } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ClaudeActivity, ClaudeStatus } from '@/modules/tmux/claude-status.js';
import type { PaneRegistry, PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { createSessionMonitor, screenTail, type MonitorSocket } from '@/modules/tmux/session-monitor.service.js';
import type { TmuxService } from '@/modules/tmux/tmux.service.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(path.join(fixtures, `${name}.txt`), 'utf8').split('\n');

class FakeSocket implements MonitorSocket {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.frames.push(JSON.parse(data));
  }
  kinds() {
    return this.frames.map((frame) => frame.kind);
  }
}

async function harness() {
  const directory = await promisify(mkdtemp)(path.join(os.tmpdir(), 'ah-monitor-'));
  const transcriptPath = path.join(directory, 'p1.jsonl');
  await promisify(writeFile)(transcriptPath, '');

  const state = {
    activity: 'idle' as ClaudeActivity,
    paneAlive: true,
    screen: fixture('idle-input'),
    clock: 1_000_000,
    sentKeys: [] as string[][],
    running: false,
    written: [] as unknown[],
    completed: [] as number[],
    attached: 0,
  };
  const paneSession = (): PaneSession => ({
    pane: { windowId: '@1', windowName: 'proj', paneId: '%1', panePid: 10, cwd: '/p', dead: false, command: 'claude' },
    providerSessionId: 'p1', transcriptPath, cwd: '/p', registered: true,
  });
  const tmux = {
    capturePane: async () => state.screen,
    sendKeys: async (_pane: string, keys: string[]) => void state.sentKeys.push(keys),
  } as unknown as TmuxService;
  const registry = {
    refresh: async () => (state.paneAlive ? [paneSession()] : []),
    findPaneForSession: async () => (state.paneAlive ? paneSession() : null),
  } as unknown as PaneRegistry;

  const monitor = createSessionMonitor({
    tmux,
    registry,
    readStatuses: async () => new Map<string, ClaudeStatus>([['p1', {
      providerSessionId: 'p1', activity: state.activity, pid: 1, probeablePid: false, updatedAt: 0, startedAt: null,
    }]]),
    resolveProviderSessionId: () => 'p1',
    resolveTranscriptPath: () => null,
    normalize: (row) => [{ kind: 'text', content: (row as { text: string }).text }],
    runs: {
      isProcessing: () => state.running,
      startRun: () => {
        if (state.running) {
          return null;
        }
        state.running = true;
        return { send: (message) => void state.written.push(message) };
      },
      getWriter: () => (state.running ? { send: (message: unknown) => void state.written.push(message) } : null),
      attach: () => void (state.attached += 1),
      complete: (_id, exitCode) => {
        state.running = false;
        state.completed.push(exitCode);
      },
    },
    now: () => state.clock,
  });
  const append = (text: string) => promisify(appendFile)(transcriptPath, `${JSON.stringify({ text })}\n`);
  return { monitor, state, append, cleanup: () => promisify(rm)(directory, { recursive: true, force: true }) };
}

test('activity typed in the terminal becomes a run that streams rows and completes on idle', async (t) => {
  const { monitor, state, append, cleanup } = await harness();
  t.after(cleanup);
  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  await monitor.tick();

  state.activity = 'busy';
  await append('hello from the phone');
  await monitor.tick();
  assert.equal(state.running, true);
  assert.equal(state.attached, 1);
  assert.deepEqual(state.written, [{ kind: 'text', content: 'hello from the phone' }]);

  state.activity = 'idle';
  await monitor.tick();
  assert.deepEqual(state.completed, [], 'waits one extra idle tick for late rows');
  await monitor.tick();
  assert.deepEqual(state.completed, [0]);
});

test('rows written while no run is active go straight to watchers', async (t) => {
  const { monitor, append, cleanup } = await harness();
  t.after(cleanup);
  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  await monitor.tick();
  await append('compact summary');
  await monitor.tick();
  assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.content, frame.sessionId]), [['text', 'compact summary', 'app1']]);
});

test('a web turn resolves when Claude returns to idle', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.running = true;
  const turn = monitor.beginTurn('app1');
  state.activity = 'busy';
  await monitor.tick();
  state.activity = 'idle';
  await monitor.tick();
  await monitor.tick();
  assert.equal(await turn, 0);
});

test('a web turn that never becomes active ends after the grace period', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.running = true;
  const turn = monitor.beginTurn('app1');
  await monitor.tick();
  assert.deepEqual(state.completed, []);
  state.clock += 25_000;
  await monitor.tick();
  assert.equal(await turn, 0);
});

test('a window that disappears mid-turn fails the run instead of leaving it processing', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  state.running = true;
  const turn = monitor.beginTurn('app1');
  state.activity = 'busy';
  await monitor.tick();
  state.paneAlive = false;
  await monitor.tick();
  assert.equal(await turn, 1);
  assert.ok(socket.kinds().includes('error'));
});

test('a waiting menu is broadcast as a prompt, answered by key, and cleared', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  const socket = new FakeSocket();
  monitor.watch('app1', socket);

  state.activity = 'waiting';
  state.screen = fixture('bash-permission');
  await monitor.tick();
  const promptFrame = socket.frames.find((frame) => frame.kind === 'tui_prompt');
  assert.ok(promptFrame);
  assert.equal((promptFrame.prompt as { question: string }).question, 'Do you want to proceed?');

  assert.equal(await monitor.chooseOption('app1', 3), true);
  assert.deepEqual(state.sentKeys.at(-1), ['Down', 'Down', 'Down', 'Enter']);

  const lateSocket = new FakeSocket();
  monitor.watch('app1', lateSocket);
  assert.equal(lateSocket.frames[0]?.kind, 'tui_prompt', 'a socket that subscribes later still sees the open prompt');

  state.activity = 'idle';
  state.screen = fixture('after-deny');
  await monitor.tick();
  assert.equal(socket.frames.at(-1)?.kind, 'tui_prompt_cleared');
});

test('screenTail keeps what is printed above the input box', () => {
  const tail = screenTail(fixture('streaming'));
  assert.equal(tail.at(-1), '* Kneading… (3s · thinking with high effort)');
  assert.ok(!tail.some((line) => line.includes('manual mode on')));
});
