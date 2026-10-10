import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createElevationQueue, ElevationRequestNotFoundError } from '@/modules/elevation/elevation-queue.service.js';

const FRESH_ID = 'a'.repeat(32);
const SILENT_ID = 'b'.repeat(32);
const ANSWERED_ID = 'c'.repeat(32);

async function withQueue(run: (queueDir: string) => Promise<void>) {
  const queueDir = await mkdtemp(path.join(os.tmpdir(), 'ah-elevation-'));
  try {
    for (const folder of ['requests', 'decisions', 'results']) {
      await mkdir(path.join(queueDir, folder));
    }
    await run(queueDir);
  } finally {
    await rm(queueDir, { recursive: true, force: true });
  }
}

async function queueRequest(queueDir: string, id: string, fields: Record<string, unknown> = {}) {
  const requestPath = path.join(queueDir, 'requests', `${id}.json`);
  await writeFile(requestPath, JSON.stringify({
    id, command: 'New-NetFirewallRule -DisplayName "x"', cwd: 'D:\\Develop\\Тест', claudePid: 4242,
    requestedAt: '2026-10-10T12:00:00.000Z', ...fields,
  }));
  return requestPath;
}

const findSession = async (claudePid: number) => (claudePid === 4242 ? { sessionId: 's1', title: 'Firewall work' } : null);

test('lists only live, unanswered requests, with the asking session', async () => {
  await withQueue(async (queueDir) => {
    await queueRequest(queueDir, FRESH_ID);
    const silentPath = await queueRequest(queueDir, SILENT_ID);
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(silentPath, longAgo, longAgo);
    await queueRequest(queueDir, ANSWERED_ID);
    await writeFile(path.join(queueDir, 'results', `${ANSWERED_ID}.json`), '{"status":"running"}');
    await writeFile(path.join(queueDir, 'requests', 'not-an-id.json'), '{}');

    const queue = createElevationQueue({ queueDir, findSessionByClaudePid: findSession });
    const snapshot = await queue.read();
    assert.equal(snapshot.brokerOnline, false);
    assert.deepEqual(snapshot.requests.map((request) => [request.id, request.sessionId, request.sessionTitle]), [[FRESH_ID, 's1', 'Firewall work']]);

    await writeFile(path.join(queueDir, 'broker.alive'), 'now');
    assert.equal((await queue.read()).brokerOnline, true);
  });
});

test('an approval carries the hash of exactly the command and folder that were shown', async () => {
  await withQueue(async (queueDir) => {
    await queueRequest(queueDir, FRESH_ID);
    const queue = createElevationQueue({ queueDir, findSessionByClaudePid: findSession });

    await queue.decide(FRESH_ID, true);
    const decision = JSON.parse(await readFile(path.join(queueDir, 'decisions', `${FRESH_ID}.json`), 'utf8'));
    const expectedHash = createHash('sha256').update('D:\\Develop\\Тест\nNew-NetFirewallRule -DisplayName "x"', 'utf8').digest('hex');
    assert.equal(decision.approved, true);
    assert.equal(decision.requestHash, expectedHash);

    assert.deepEqual((await queue.read()).requests, []);
    await assert.rejects(queue.decide(FRESH_ID, false), ElevationRequestNotFoundError);
  });
});

test('unknown, malformed and path-like ids cannot be decided', async () => {
  await withQueue(async (queueDir) => {
    await queueRequest(queueDir, FRESH_ID, { command: '' });
    const queue = createElevationQueue({ queueDir, findSessionByClaudePid: findSession });
    await assert.rejects(queue.decide(FRESH_ID, true), ElevationRequestNotFoundError);
    await assert.rejects(queue.decide('../../etc/passwd', true), ElevationRequestNotFoundError);
    await assert.rejects(queue.decide(SILENT_ID, true), ElevationRequestNotFoundError);
  });
});
