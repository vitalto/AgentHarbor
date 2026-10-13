// Router mounted at /api/power by server/index.ts: powers the computer off once every agent has finished.
import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';
import { createPowerControl } from '@/modules/power/power-control.js';
import { createPowerRouter } from '@/modules/power/power.routes.js';
import { createShutdownWhenIdle, type ArmRecord } from '@/modules/power/shutdown-when-idle.service.js';
import { findUnfinishedAgents, type UnfinishedAgent } from '@/modules/tmux/index.js';

const ARM_STORAGE_KEY = 'power.shutdown_when_idle';

function readArmRecord(): ArmRecord | null {
  const raw = appConfigDb.get(ARM_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const record = JSON.parse(raw) as Partial<ArmRecord>;
    return typeof record.armedAt === 'number'
      ? { armedAt: record.armedAt, armedBy: typeof record.armedBy === 'number' ? record.armedBy : null }
      : null;
  } catch {
    return null;
  }
}

/** An unfinished agent as Settings lists it: by the chat it belongs to, when AgentHarbor knows that chat. */
type WatchedAgent = UnfinishedAgent & { sessionId: string | null; title: string | null };

async function findWatchedAgents(): Promise<WatchedAgent[]> {
  return (await findUnfinishedAgents()).map((agent) => {
    const session = sessionsDb.getSessionByProviderSessionId(agent.providerSessionId);
    return { ...agent, sessionId: session?.session_id ?? null, title: session?.custom_name ?? null };
  });
}

const shutdownWhenIdle = createShutdownWhenIdle({
  findUnfinishedAgents: findWatchedAgents,
  powerControl: createPowerControl(),
  armStore: {
    read: readArmRecord,
    write: (record) => (record ? appConfigDb.set(ARM_STORAGE_KEY, JSON.stringify(record)) : appConfigDb.remove(ARM_STORAGE_KEY)),
  },
  notify: (userId, message) => {
    if (userId === null) {
      return;
    }
    notifyUserIfEnabled({
      userId,
      event: createNotificationEvent({ provider: 'system', code: 'agent.notification', meta: { message } }),
    });
  },
});

export const powerRoutes = createPowerRouter(shutdownWhenIdle);

/** Called once the database is open: an arm survives server restarts. */
export function startShutdownWhenIdle(): void {
  shutdownWhenIdle.start();
}
