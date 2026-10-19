import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sendWithoutSocket } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { AnyRecord } from '@/shared/types.js';

const SESSION_ID = 'cli-session';

type Recorded = {
  runs: Array<{ command: string; options: AnyRecord }>;
  typed: string[];
};

async function withSession(
  { busy, hasWindow = true }: { busy: boolean; hasWindow?: boolean },
  runTest: (recorded: Recorded, dependencies: Parameters<typeof sendWithoutSocket>[2]) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-without-socket-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const recorded: Recorded = { runs: [], typed: [] };
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    if (busy) {
      chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    }
    await runTest(recorded, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, command: string, options: AnyRecord) => {
          recorded.runs.push({ command, options });
        },
      } as never,
      terminal: {
        typeWhileBusy: async (_sessionId: string, text: string) => {
          recorded.typed.push(text);
          return hasWindow;
        },
      } as never,
    });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an idle session starts a turn with the requested model and effort', async () => {
  await withSession({ busy: false }, async (recorded, dependencies) => {
    const result = await sendWithoutSocket(1, {
      sessionId: SESSION_ID,
      content: 'continue the migration',
      options: { model: 'sonnet', effort: 'low' },
    }, dependencies);

    assert.deepEqual(result, { delivery: 'started' });
    assert.equal(recorded.runs.length, 1);
    assert.equal(recorded.runs[0].command, 'continue the migration');
    assert.equal(recorded.runs[0].options.model, 'sonnet');
    assert.equal(recorded.runs[0].options.effort, 'low');
  });
});

test('a busy session queues the text in its window instead of starting a run', async () => {
  await withSession({ busy: true }, async (recorded, dependencies) => {
    const result = await sendWithoutSocket(1, { sessionId: SESSION_ID, content: 'also check the tests' }, dependencies);

    assert.deepEqual(result, { delivery: 'queued' });
    assert.deepEqual(recorded.typed, ['also check the tests']);
    assert.equal(recorded.runs.length, 0);
  });
});

test('a busy session without a window reports the conflict', async () => {
  await withSession({ busy: true, hasWindow: false }, async (_recorded, dependencies) => {
    const result = await sendWithoutSocket(1, { sessionId: SESSION_ID, content: 'hello' }, dependencies);
    assert.equal('code' in result && result.code, 'RUN_IN_PROGRESS');
  });
});

test('an unknown session is reported, not created', async () => {
  await withSession({ busy: false }, async (recorded, dependencies) => {
    const result = await sendWithoutSocket(1, { sessionId: 'missing', content: 'hello' }, dependencies);
    assert.equal('code' in result && result.code, 'SESSION_NOT_FOUND');
    assert.equal(recorded.runs.length, 0);
  });
});
