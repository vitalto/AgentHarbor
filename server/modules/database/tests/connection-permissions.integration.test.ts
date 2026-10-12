import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/index.js';

test('the database holding the JWT secret is readable by its owner only', { skip: process.platform === 'win32' }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'db-permissions-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  await writeFile(databasePath, '', { mode: 0o644 });

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  try {
    getConnection();
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
