import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { describeAgentSettings, getAgentConfig } from '@/modules/tmux/agent-config.js';
import { loadStoredAgentSettings, saveAgentSettings } from '@/modules/tmux/agent-settings.js';
import { AppError } from '@/shared/utils.js';

test('saved agent settings override the environment, survive a reload and reset back to it', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousIdleClose = process.env.AH_IDLE_CLOSE_MINUTES;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-settings-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.AH_IDLE_CLOSE_MINUTES = '45';
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    loadStoredAgentSettings();
    assert.equal(getAgentConfig().idleCloseMinutes, 45);

    saveAgentSettings({ idleCloseMinutes: 10, attachmentRetentionDays: 3, backgroundReminderMinutes: 0 });
    loadStoredAgentSettings();
    assert.deepEqual(describeAgentSettings().values, { idleCloseMinutes: 10, attachmentRetentionDays: 3, backgroundReminderMinutes: 0 });
    assert.deepEqual(describeAgentSettings().defaults, { idleCloseMinutes: 45, attachmentRetentionDays: 7, backgroundReminderMinutes: 60 });

    saveAgentSettings({ idleCloseMinutes: null });
    loadStoredAgentSettings();
    assert.equal(getAgentConfig().idleCloseMinutes, 45);
    assert.equal(getAgentConfig().attachmentRetentionDays, 3);

    for (const invalid of [{ idleCloseMinutes: -1 }, { idleCloseMinutes: 1.5 }, { attachmentRetentionDays: 0 }, { unknown: 1 }, [], 'x']) {
      assert.throws(() => saveAgentSettings(invalid), AppError);
    }
    assert.throws(() => saveAgentSettings({ attachmentRetentionDays: 5, idleCloseMinutes: '5' }), AppError);
    assert.equal(getAgentConfig().attachmentRetentionDays, 3, 'a rejected update writes nothing');
  } finally {
    saveAgentSettings({ idleCloseMinutes: null, attachmentRetentionDays: null, backgroundReminderMinutes: null });
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    if (previousIdleClose === undefined) {
      delete process.env.AH_IDLE_CLOSE_MINUTES;
    } else {
      process.env.AH_IDLE_CLOSE_MINUTES = previousIdleClose;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
