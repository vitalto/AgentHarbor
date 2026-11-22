import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldCloseIdleAgent, sweepIdleAgents, type IdleAgentFacts } from '@/modules/tmux/idle-reaper.service.js';

import { paneRegistry } from '@/modules/tmux/pane-registry.service.js';
import { tmuxService, type AgentPane } from '@/modules/tmux/tmux.service.js';

const HOUR = 60 * 60_000;
const now = 10 * HOUR;
const idle = (overrides: Partial<IdleAgentFacts> = {}): IdleAgentFacts => ({
  status: { activity: 'idle', status: 'idle', statusSince: now - 2 * HOUR },
  lastWriteAt: now - 2 * HOUR,
  viewers: 0,
  now,
  idleLimitMs: HOUR,
  ...overrides,
});

test('an agent untouched for longer than the limit is closed', () => {
  assert.equal(shouldCloseIdleAgent(idle()), true);
});

test('recent writes (the turn or a subagent) keep it open', () => {
  assert.equal(shouldCloseIdleAgent(idle({ lastWriteAt: now - 10 * 60_000 })), false);
});

test('work in progress keeps it open: a turn, a menu, a background command', () => {
  assert.equal(shouldCloseIdleAgent(idle({ status: { activity: 'busy', status: 'busy', statusSince: 0 } })), false);
  assert.equal(shouldCloseIdleAgent(idle({ status: { activity: 'waiting', status: 'waiting', statusSince: 0 } })), false);
  assert.equal(shouldCloseIdleAgent(idle({ status: { activity: 'idle', status: 'shell', statusSince: 0 } })), false);
});

test('a window someone is looking at stays open', () => {
  assert.equal(shouldCloseIdleAgent(idle({ viewers: 1 })), false);
});

test('without any timestamp nothing is closed', () => {
  assert.equal(shouldCloseIdleAgent(idle({ status: null, lastWriteAt: null })), false);
});

test('the idle sweep closes an unattended Codex window after the configured interval', async (t) => {
  const pane: AgentPane = {
    windowId: '@20', paneId: '%20', windowName: 'codex-test', panePid: 1, dead: false,
    cwd: '', command: 'codex', currentCommand: 'codex',
  };
  t.mock.method(paneRegistry, 'refresh', async () => []);
  let viewers = 0;
  t.mock.method(tmuxService, 'countViewers', async () => viewers);
  let screenBusy = true;
  let liveBackground = false;
  t.mock.method(tmuxService, 'inspectPane', async () => ({
    lines: [screenBusy ? 'Working (esc to interrupt)' : liveBackground ? '  1 background terminal running · /ps to view' : '', '› '],
    cursorX: 2, cursorY: 1, cursorVisible: true, dead: false, title: '',
  }));
  const kill = t.mock.method(tmuxService, 'killPane', async () => {});
  const originalLimit = process.env.AH_IDLE_CLOSE_MINUTES;
  process.env.AH_IDLE_CLOSE_MINUTES = '30';
  t.after(() => {
    if (originalLimit === undefined) delete process.env.AH_IDLE_CLOSE_MINUTES;
    else process.env.AH_IDLE_CLOSE_MINUTES = originalLimit;
  });
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const listThreads = async () => [
    { providerSessionId: 'owned', pane, activity: 'idle' as const, updatedAt: now },
    { providerSessionId: 'busy', pane: { ...pane, windowId: '@21' }, activity: 'working' as const, updatedAt: now },
    { providerSessionId: 'waiting', pane: { ...pane, windowId: '@22' }, activity: 'waiting' as const, updatedAt: now },
    { providerSessionId: 'draft', pane: { ...pane, windowId: '@23' }, activity: 'unknown' as const, updatedAt: now },
    { providerSessionId: 'background', pane: { ...pane, windowId: '@24' }, activity: 'idle' as const, updatedAt: now, backgroundTerminalCount: 1 },
    { providerSessionId: 'external', pane: null, activity: 'idle' as const, updatedAt: now },
  ];
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  clock += 30 * 60_000;
  viewers = 1;
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  viewers = 0;
  process.env.AH_IDLE_CLOSE_MINUTES = '0';
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  process.env.AH_IDLE_CLOSE_MINUTES = '30';
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  clock += 30 * 60_000;
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  screenBusy = false;
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  clock += 30 * 60_000;
  liveBackground = true;
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  liveBackground = false;
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  clock += 30 * 60_000;
  assert.deepEqual(await sweepIdleAgents(listThreads, (id) => id === 'owned'), []);
  assert.equal(kill.mock.callCount(), 0);
  assert.deepEqual(await sweepIdleAgents(listThreads), []);
  clock += 30 * 60_000;
  assert.deepEqual(await sweepIdleAgents(listThreads), ['codex-test']);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[0]), ['%20']);
});
