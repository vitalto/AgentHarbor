import assert from 'node:assert/strict';
import test from 'node:test';

import type { PowerControl } from '@/modules/power/power-control.js';
import { createShutdownWhenIdle } from '@/modules/power/shutdown-when-idle.service.js';
import type { UnfinishedAgent } from '@/modules/tmux/index.js';

const QUIET_PERIOD_MS = 120_000;
const busyAgent: UnfinishedAgent = { providerSessionId: 'session-1', cwd: '/home/alice/sandbox', work: 'turn' };

function createHarness({ failShutdown = false } = {}) {
  let clock = 1_000_000;
  let agents: UnfinishedAgent[] = [busyAgent];
  let cancellations = 0;
  const shutdownDelays: number[] = [];
  const notifications: Array<[number | null, string]> = [];
  const powerControl: PowerControl = {
    scheduleShutdown: async (delaySeconds) => {
      if (failShutdown) {
        throw new Error('access denied');
      }
      shutdownDelays.push(delaySeconds);
    },
    cancelShutdown: async () => {
      cancellations += 1;
    },
  };
  const service = createShutdownWhenIdle({
    findUnfinishedAgents: async () => agents,
    powerControl,
    notify: (userId, message) => notifications.push([userId, message]),
    now: () => clock,
    quietPeriodMs: QUIET_PERIOD_MS,
    shutdownDelaySeconds: 60,
  });
  return {
    service,
    shutdownDelays,
    notifications,
    advance: (ms: number) => {
      clock += ms;
    },
    setAgents: (next: UnfinishedAgent[]) => {
      agents = next;
    },
    cancellations: () => cancellations,
  };
}

test('nothing happens while it is not armed', async () => {
  const { service, setAgents, advance, shutdownDelays } = createHarness();
  setAgents([]);
  await service.check();
  advance(QUIET_PERIOD_MS);
  await service.check();
  assert.deepEqual(shutdownDelays, []);
});

test('arming lists the agents still working, and they hold the shutdown back', async () => {
  const { service, advance, shutdownDelays } = createHarness();
  const state = await service.arm(7);
  assert.equal(state.armed, true);
  assert.deepEqual(state.unfinishedAgents, [busyAgent]);
  advance(10 * QUIET_PERIOD_MS);
  await service.check();
  assert.deepEqual(shutdownDelays, []);
});

test('the shutdown starts once every agent stayed finished for the quiet period, then it disarms', async () => {
  const { service, advance, setAgents, shutdownDelays, notifications } = createHarness();
  await service.arm(7);
  setAgents([]);
  await service.check();
  advance(QUIET_PERIOD_MS - 1);
  await service.check();
  assert.deepEqual(shutdownDelays, []);

  advance(1);
  await service.check();
  assert.deepEqual(shutdownDelays, [60]);
  const state = service.getState();
  assert.equal(state.armed, false);
  assert.notEqual(state.shutdownAt, null);
  assert.deepEqual(notifications.map(([userId]) => userId), [7]);
});

test('work starting again inside the quiet period restarts it', async () => {
  const { service, advance, setAgents, shutdownDelays } = createHarness();
  await service.arm(null);
  setAgents([]);
  await service.check();
  advance(QUIET_PERIOD_MS - 1000);
  setAgents([{ ...busyAgent, work: 'subagent' }]);
  await service.check();
  setAgents([]);
  advance(1000);
  await service.check();
  advance(QUIET_PERIOD_MS - 1);
  await service.check();
  assert.deepEqual(shutdownDelays, []);
});

test('disarming stops it, and a pending shutdown can be cancelled', async () => {
  const { service, advance, setAgents, shutdownDelays, cancellations } = createHarness();
  await service.arm(null);
  service.disarm();
  setAgents([]);
  advance(QUIET_PERIOD_MS);
  await service.check();
  assert.deepEqual(shutdownDelays, []);

  await service.arm(null);
  advance(QUIET_PERIOD_MS);
  await service.check();
  assert.deepEqual(shutdownDelays, [60]);
  const state = await service.cancelShutdown();
  assert.equal(state.shutdownAt, null);
  assert.equal(cancellations(), 1);
});

test('a refused shutdown is reported once instead of being retried', async () => {
  const { service, advance, setAgents, notifications } = createHarness({ failShutdown: true });
  setAgents([]);
  await service.arm(3);
  advance(QUIET_PERIOD_MS);
  await service.check();
  const state = service.getState();
  assert.equal(state.armed, false);
  assert.match(state.lastError ?? '', /access denied/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][1], /failed/);
});
