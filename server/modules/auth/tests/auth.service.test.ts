import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['hash:secret12', 'begin', 'create:alice:hash', 'commit', 'login:1']);
});

test('register refuses once a user exists without spending a bcrypt hash', async () => {
  let hashed = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    hashPassword: async () => {
      hashed = true;
      return 'hash';
    },
  }));

  await assert.rejects(
    service.register('mallory', 'secret12'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_USER_ALREADY_CONFIGURED',
  );
  assert.equal(hashed, false);
});

test('a registration racing the first one is refused cleanly instead of colliding with its open transaction', async () => {
  const createdUsers: string[] = [];
  let inTransaction = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => createdUsers.length > 0,
      createUser: (username, passwordHash) => {
        createdUsers.push(username);
        return { id: createdUsers.length, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => {
        if (inTransaction) {
          throw new Error('cannot start a transaction within a transaction');
        }
        inTransaction = true;
      },
      commit: () => { inTransaction = false; },
      rollback: () => { inTransaction = false; },
    },
  }));

  const results = await Promise.allSettled([
    service.register('alice', 'secret12'),
    service.register('mallory', 'secret12'),
  ]);

  assert.deepEqual(createdUsers, ['alice']);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.ok(results[1].status === 'rejected'
    && results[1].reason instanceof AppError
    && results[1].reason.code === 'AUTH_USER_ALREADY_CONFIGURED');
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password', '203.0.113.7'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('login locks a client out after ten attempts in fifteen minutes, without checking the password', async () => {
  let currentTime = 1_000_000;
  let passwordChecks = 0;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async (password) => {
      passwordChecks += 1;
      return password === 'right-password';
    },
    now: () => currentTime,
  }));

  await Promise.allSettled(Array.from({ length: 10 }, () => service.login('alice', 'guess', '203.0.113.7')));
  assert.equal(passwordChecks, 10);

  await assert.rejects(
    service.login('alice', 'right-password', '203.0.113.7'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_TOO_MANY_ATTEMPTS' && error.statusCode === 429,
  );
  assert.equal(passwordChecks, 10);

  const otherClient = await service.login('alice', 'right-password', '198.51.100.2');
  assert.equal(otherClient.success, true);

  currentTime += 15 * 60_000;
  const afterWindow = await service.login('alice', 'right-password', '203.0.113.7');
  assert.equal(afterWindow.success, true);
});

test('login with an unknown username still spends a bcrypt round', async () => {
  let hashed = false;
  const service = createAuthService(createDependencies({
    hashPassword: async () => {
      hashed = true;
      return 'hash';
    },
  }));

  await assert.rejects(
    service.login('nobody', 'guess', '203.0.113.7'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(hashed, true);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});
