import type { PowerControl } from '@/modules/power/power-control.js';

/**
 * Every agent must stay done this long before the shutdown starts: a turn
 * ending, a background agent reporting back and the next turn starting leave
 * short gaps that must not count as "finished".
 */
const DEFAULT_QUIET_PERIOD_MS = 2 * 60_000;
/** The OS countdown, which is the user's window to cancel. */
const DEFAULT_SHUTDOWN_DELAY_SECONDS = 60;
const DEFAULT_CHECK_INTERVAL_MS = 20_000;

type ArmRecord = {
  armedAt: number;
  /** Who armed it, to tell them when the shutdown starts. */
  armedBy: number | null;
};

export type ShutdownWhenIdleState<TAgent> = {
  armed: boolean;
  armedAt: number | null;
  /** Agents that still have work going on, as of the last check. */
  unfinishedAgents: TAgent[];
  /** Since when no agent has had anything going on (only while armed). */
  idleSince: number | null;
  /** When the OS will power off; null when no shutdown is pending. */
  shutdownAt: number | null;
  checkedAt: number | null;
  lastError: string | null;
  quietPeriodMs: number;
  shutdownDelaySeconds: number;
};

export type ShutdownWhenIdleDependencies<TAgent> = {
  findUnfinishedAgents(): Promise<TAgent[]>;
  powerControl: PowerControl;
  notify(userId: number | null, message: string): void;
  now?: () => number;
  quietPeriodMs?: number;
  shutdownDelaySeconds?: number;
};

export type ShutdownWhenIdle<TAgent> = ReturnType<typeof createShutdownWhenIdle<TAgent>>;

/**
 * One-shot, like a sleep timer: once armed, waits until no Claude process has
 * a turn, a background command or a running subagent for the quiet period,
 * then asks the OS to power off and disarms itself. The arm lives only in
 * memory, so a server restart drops it.
 */
export function createShutdownWhenIdle<TAgent>({
  findUnfinishedAgents,
  powerControl,
  notify,
  now = Date.now,
  quietPeriodMs = DEFAULT_QUIET_PERIOD_MS,
  shutdownDelaySeconds = DEFAULT_SHUTDOWN_DELAY_SECONDS,
}: ShutdownWhenIdleDependencies<TAgent>) {
  let arm: ArmRecord | null = null;
  let unfinishedAgents: TAgent[] = [];
  let idleSince: number | null = null;
  let shutdownAt: number | null = null;
  let checkedAt: number | null = null;
  let lastError: string | null = null;
  let checkInFlight: Promise<void> | null = null;

  const setArm = (record: ArmRecord | null) => {
    arm = record;
    unfinishedAgents = [];
    idleSince = null;
    checkedAt = null;
  };

  const getState = (): ShutdownWhenIdleState<TAgent> => ({
    armed: arm !== null,
    armedAt: arm?.armedAt ?? null,
    unfinishedAgents,
    idleSince,
    shutdownAt: shutdownAt !== null && shutdownAt > now() ? shutdownAt : null,
    checkedAt,
    lastError,
    quietPeriodMs,
    shutdownDelaySeconds,
  });

  async function startShutdown(armedBy: number | null): Promise<void> {
    setArm(null);
    try {
      await powerControl.scheduleShutdown(shutdownDelaySeconds, 'AgentHarbor: all agents have finished.');
      shutdownAt = now() + shutdownDelaySeconds * 1000;
      lastError = null;
      notify(armedBy, `All agents have finished. The computer shuts down in ${shutdownDelaySeconds} s; cancel it in Settings.`);
    } catch (error) {
      lastError = (error as Error).message;
      notify(armedBy, `All agents have finished, but the shutdown failed: ${lastError}`);
    }
  }

  async function runCheck(): Promise<void> {
    if (!arm) {
      return;
    }
    const armedBy = arm.armedBy;
    const found = await findUnfinishedAgents();
    if (!arm) {
      return;
    }
    const checkTime = now();
    unfinishedAgents = found;
    checkedAt = checkTime;
    if (found.length > 0) {
      idleSince = null;
      return;
    }
    idleSince ??= checkTime;
    if (checkTime - idleSince >= quietPeriodMs) {
      await startShutdown(armedBy);
    }
  }

  /** One look at the agents; concurrent callers share the check already running. */
  function check(): Promise<void> {
    checkInFlight ??= runCheck()
      .catch((error: unknown) => {
        lastError = (error as Error).message;
      })
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  }

  return {
    getState,
    check,
    async arm(userId: number | null): Promise<ShutdownWhenIdleState<TAgent>> {
      setArm({ armedAt: now(), armedBy: userId });
      lastError = null;
      // A check started before arming saw nothing to do; look again so the answer lists the agents.
      await checkInFlight;
      await check();
      return getState();
    },
    disarm(): ShutdownWhenIdleState<TAgent> {
      setArm(null);
      return getState();
    },
    async cancelShutdown(): Promise<ShutdownWhenIdleState<TAgent>> {
      await powerControl.cancelShutdown();
      shutdownAt = null;
      return getState();
    },
    start(intervalMs = DEFAULT_CHECK_INTERVAL_MS): void {
      setInterval(() => void check(), intervalMs).unref();
    },
  };
}
