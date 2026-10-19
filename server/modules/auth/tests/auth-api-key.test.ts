import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apiKeysDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

type FakeResponse = { statusCode: number; body: unknown; status(code: number): FakeResponse; json(body: unknown): FakeResponse; setHeader(): void };

function createResponse(): FakeResponse {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };
}

test('a key from Settings -> API keys authenticates as its owner; an unknown key does not', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'auth-api-key-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    // Imported after the database opens: the middleware reads its JWT secret from it on load.
    const { authenticateToken } = await import('@/modules/auth/auth.middleware.js');
    const { id: userId } = userDb.createUser('alice', 'hash');
    const { apiKey } = apiKeysDb.createApiKey(Number(userId), 'cli');

    const accepted = { headers: { authorization: `Bearer ${apiKey}` }, query: {} } as Record<string, unknown>;
    let nextCalls = 0;
    await authenticateToken(accepted, createResponse(), () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal((accepted.user as { username: string }).username, 'alice');

    const rejectedResponse = createResponse();
    await authenticateToken({ headers: { authorization: 'Bearer ck_unknown' }, query: {} }, rejectedResponse, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal(rejectedResponse.statusCode, 401);
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
