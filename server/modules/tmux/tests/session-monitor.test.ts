import assert from 'node:assert/strict';
import { appendFile, mkdirSync, mkdtemp, readFileSync, rm, utimesSync, writeFile, writeFileSync } from 'node:fs';
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
    paneRegistered: true,
    /** Claude still runs for the session but outside tmux (e.g. a Windows console). */
    runsElsewhere: false,
    screen: fixture('idle-input'),
    clock: 1_000_000,
    sentKeys: [] as string[][],
    pasted: [] as string[],
    onPaste: (_text: string) => {},
    running: false,
    written: [] as unknown[],
    completed: [] as number[],
    attached: 0,
    restoredWindows: [] as string[],
  };
  const paneSession = (): PaneSession => ({
    pane: { windowId: '@1', windowName: 'proj', paneId: '%1', panePid: 10, cwd: '/p', dead: false, command: 'claude', currentCommand: 'init' },
    providerSessionId: 'p1', transcriptPath, cwd: '/p', registered: state.paneRegistered,
  });
  const tmux = {
    capturePane: async () => state.screen,
    restoreShrunkWindow: async (windowId: string) => void state.restoredWindows.push(windowId),
    sendKeys: async (_pane: string, keys: string[]) => void state.sentKeys.push(keys),
    pasteText: async (_pane: string, text: string) => state.onPaste(text),
  } as unknown as TmuxService;
  const registry = {
    refresh: async () => (state.paneAlive ? [paneSession()] : []),
    findPaneForSession: async () => (state.paneAlive ? paneSession() : null),
  } as unknown as PaneRegistry;

  const monitor = createSessionMonitor({
    tmux,
    registry,
    readStatuses: async () => (state.paneAlive || state.runsElsewhere
      ? new Map<string, ClaudeStatus>([['p1', {
        providerSessionId: 'p1', activity: state.activity, status: state.activity, statusSince: null, pid: 1, windowsPid: state.runsElsewhere, cwd: null, updatedAt: 0, startedAt: null, processCount: 1,
      }]])
      : new Map<string, ClaudeStatus>()),
    resolveProviderSessionId: () => 'p1',
    resolveTranscriptPath: () => transcriptPath,
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
  return { monitor, state, append, directory, cleanup: () => promisify(rm)(directory, { recursive: true, force: true }) };
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
  assert.deepEqual(state.restoredWindows, ['@1'], 'a window a phone shrank is restored before its menu is read');

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

test('a free-text answer is typed into the "Type something." slot before Enter; an empty one is refused', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.activity = 'waiting';
  state.screen = fixture('ask-question');

  // An empty Enter on that slot makes Claude decline the whole question set.
  assert.equal(await monitor.chooseOption('app1', 3), false);
  assert.equal(await monitor.chooseOption('app1', 3, '   '), false);
  assert.deepEqual(state.sentKeys, []);

  state.onPaste = (text) => {
    state.pasted.push(text);
    state.screen = fixture('ask-question-free-text-typed');
  };
  assert.equal(await monitor.chooseOption('app1', 3, 'typed so far'), true);
  assert.deepEqual(state.sentKeys, [['Down', 'Down', 'Down'], ['Enter']]);
  assert.deepEqual(state.pasted, ['typed so far']);
});

test('a free-text answer whose paste never shows up is not submitted', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.activity = 'waiting';
  state.screen = fixture('ask-question');
  state.onPaste = (text) => void state.pasted.push(text);

  assert.equal(await monitor.chooseOption('app1', 3, 'lost'), false);
  assert.deepEqual(state.sentKeys, [['Down', 'Down', 'Down']]);
});

test('a multi-select free-text answer is typed but not confirmed, since Enter would untick it', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.activity = 'waiting';
  state.screen = fixture('multi-select-checked');
  state.onPaste = (text) => {
    state.pasted.push(text);
    state.screen = fixture('multi-select-free-text-typed');
  };

  assert.equal(await monitor.chooseOption('app1', 2, 'kiwi'), true);
  assert.deepEqual(state.sentKeys, [['Down', 'Down']]);
  assert.deepEqual(state.pasted, ['kiwi']);
});

test('a free-text slot that already holds text is cleared before the new answer is typed', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.activity = 'waiting';
  state.screen = fixture('multi-select-next');
  state.onPaste = (text) => {
    state.pasted.push(text);
    state.screen = fixture('multi-select-free-text-typed');
  };

  assert.equal(await monitor.chooseOption('app1', 2, 'kiwi'), true);
  assert.deepEqual(state.sentKeys, [['Up'], ['End', 'C-u']]);
});

test('switching questions leaves a free-text slot first, where the arrows would move the text cursor', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  state.activity = 'waiting';

  state.screen = fixture('bash-permission');
  assert.equal(await monitor.switchQuestion('app1', 'previous'), false, 'a permission prompt has no questions to switch');

  state.screen = fixture('multi-select-checked');
  assert.equal(await monitor.switchQuestion('app1', 'next'), true);
  assert.deepEqual(state.sentKeys.at(-1), ['Right']);

  state.screen = fixture('multi-select-free-text-typed');
  assert.equal(await monitor.switchQuestion('app1', 'previous'), true);
  assert.deepEqual(state.sentKeys.at(-1), ['Up', 'Up', 'Left']);
});

test('a window still starting up has its menus surfaced and answered before it registers', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  state.paneAlive = false;
  state.screen = fixture('trust-folder');
  monitor.setStartingPane('app1', '%9');
  state.running = true;
  void monitor.beginTurn('app1');

  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(socket.kinds(), ['tui_prompt'], 'no flapping and no "window closed" while starting');
  assert.deepEqual(state.completed, []);

  assert.equal(await monitor.chooseOption('app1', 1), true);
  assert.deepEqual(state.sentKeys.at(-1), ['Down', 'Enter']);
});

test('a starting window guessed by its folder (not yet registered) still has its trust dialog surfaced', async (t) => {
  const { monitor, state, cleanup } = await harness();
  t.after(cleanup);
  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  state.paneRegistered = false;
  state.screen = fixture('trust-folder');
  monitor.setStartingPane('app1', '%1');

  await monitor.tick();
  assert.deepEqual(socket.kinds(), ['tui_prompt']);
});

test('a session running outside tmux is mirrored read-only and its turns complete', async (t) => {
  const { monitor, state, append, cleanup } = await harness();
  t.after(cleanup);
  state.paneAlive = false;
  state.runsElsewhere = true;
  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  await monitor.tick();

  state.activity = 'busy';
  await append('typed in the Windows console');
  await monitor.tick();
  assert.equal(state.running, true);
  assert.deepEqual(state.written, [{ kind: 'text', content: 'typed in the Windows console' }]);
  assert.ok(!socket.kinds().includes('error'), 'no "window closed" error for a session that runs elsewhere');

  state.activity = 'idle';
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(state.completed, [0]);
});

test('screenTail keeps what is printed above the input box', () => {
  const tail = screenTail(fixture('streaming'));
  assert.equal(tail.at(-1), '* Kneading… (3s · thinking with high effort)');
  assert.ok(!tail.some((line) => line.includes('manual mode on')));
});

test('writes by a subagent are announced so the viewer reloads its timeline', async (t) => {
  const { monitor, state, directory, cleanup } = await harness();
  t.after(cleanup);
  const subagents = path.join(directory, 'p1', 'subagents');
  mkdirSync(subagents, { recursive: true });
  const agentTranscript = path.join(subagents, 'agent-a1.jsonl');
  writeFileSync(agentTranscript, '{}\n');
  utimesSync(agentTranscript, new Date(1_000_000), new Date(1_000_000));

  const socket = new FakeSocket();
  monitor.watch('app1', socket);
  await monitor.tick();
  assert.ok(!socket.kinds().includes('subagents_updated'), 'the first look only takes a baseline');

  utimesSync(agentTranscript, new Date(2_000_000), new Date(2_000_000));
  await monitor.tick();
  assert.ok(!socket.kinds().includes('subagents_updated'), 'checked at most every few seconds');

  state.clock += 3500;
  await monitor.tick();
  assert.deepEqual(socket.kinds().filter((kind) => kind === 'subagents_updated'), ['subagents_updated']);
});
