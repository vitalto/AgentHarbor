import assert from 'node:assert/strict';
import fs, { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import express from 'express';

import { closeConnection, initializeDatabase, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { removeSessionTranscript, retainSessionTranscript, retrySessionTranscriptRetention } from '@/shared/index.js';

// Each provider synchronizer resolves `os.homedir()` when the registry module is
// first imported, so HOME has to point at an empty fixture home *before* that
// import runs. Otherwise the sync pass walks the developer's real ~/.claude.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-prune-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.AH_CODEX_HOME = path.join(fixtureHome, '.codex');
process.env.CLAUDE_CONFIG_DIR = path.join(fixtureHome, '.claude');

const { sessionSynchronizerService } = await import(
  '@/modules/providers/services/session-synchronizer.service.js'
);
const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
const { default: providerRoutes } = await import('@/modules/providers/provider.routes.js');
test.after(() => rm(fixtureHome, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }));

process.on('exit', () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

async function withIsolatedDatabase(runTest: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-prune-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const PROJECT_PATH = '/tmp/session-prune-project';

test('a previously indexed top-level Claude conversation survives native cleanup until permanent app deletion', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const id = '019c3333-4000-7000-8000-123456789abe';
    const config = process.env.CLAUDE_CONFIG_DIR!;
    const project = path.join(config, 'projects', 'project');
    const file = path.join(project, id + '.jsonl');
    const retained = path.join(config, 'agentharbor-history', 'project', id + '.jsonl');
    const text = JSON.stringify({ type: 'user', uuid: 'prompt-id', sessionId: id, cwd: workspace, timestamp: '2026-02-11T00:00:00Z', message: { role: 'user', content: 'old Claude history' } }) + '\n';
    await mkdir(project, { recursive: true });
    await writeFile(file, text);
    sessionsDb.createSession(id, 'claude', workspace, 'Old session', undefined, undefined, file);
    scanStateDb.updateLastScannedAt(new Date(Date.now() + 60_000));
    assert.equal((await sessionSynchronizerService.synchronizeSessions()).processedByProvider.claude, 0);
    assert.equal(await readFile(retained, 'utf8'), text);
    await rm(project, { recursive: true });
    assert.equal((await sessionsService.fetchHistory(id)).messages[0].content, 'old Claude history');
    assert.equal(await readFile(file, 'utf8'), text);
    await sessionsService.deleteOrArchiveSessionById(id, { force: true, deletedFromDisk: true });
    await sessionSynchronizerService.synchronizeSessions();
    assert.equal(sessionsDb.getSessionById(id), null);
    await assert.rejects(stat(retained), { code: 'ENOENT' });
  });
});

test('synchronizeSessions drops indexed sessions whose transcript file was deleted', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcriptDirectory = path.join(workspace, 'transcripts');
    await mkdir(transcriptDirectory, { recursive: true });

    const livePath = path.join(transcriptDirectory, 'live.jsonl');
    await writeFile(livePath, '{}\n');
    const deletedPath = path.join(transcriptDirectory, 'deleted.jsonl');

    sessionsDb.createSession('live-session', 'claude', PROJECT_PATH, 'Live', undefined, undefined, livePath);
    sessionsDb.createSession('orphan-session', 'claude', PROJECT_PATH, 'Untitled Claude Session', undefined, undefined, deletedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(result.failures, []);
    assert.equal(result.prunedOrphans, 1);
    assert.equal(sessionsDb.getSessionById('orphan-session'), null);
    assert.ok(sessionsDb.getSessionById('live-session'), 'a session whose transcript still exists must survive');
  });
});

test('the session routes restore a native Codex archive and keep its history after a sidebar archive and restore', async (t) => {
  await withIsolatedDatabase(async (workspace) => {
    const home = process.env.AH_CODEX_HOME!;
    const id = '019c3333-4000-7000-8000-123456789abd';
    const name = 'rollout-2026-02-11T00-00-00-' + id + '.jsonl';
    const archived = path.join(home, 'archived_sessions', name);
    const timestamp = '2026-02-11T00:00:00.000Z';
    const meta = { id, cwd: workspace, timestamp, originator: 'codex_cli_rs', cli_version: '0.169.0', source: 'cli', model_provider: 'openai' };
    await mkdir(path.dirname(archived), { recursive: true });
    await writeFile(archived, [
      { timestamp, type: 'session_meta', payload: meta },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'history through HTTP', images: [] } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await sessionSynchronizerService.synchronizeProviderFile('codex', archived);

    const server = express().use(providerRoutes).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port + '/sessions/' + id;
    const nativeCommand = process.env.AH_TEST_NATIVE_CODEX;
    if (nativeCommand) {
      const previous = process.env.AH_CODEX_CMD;
      t.after(() => {
        if (previous === undefined) delete process.env.AH_CODEX_CMD;
        else process.env.AH_CODEX_CMD = previous;
      });
      process.env.AH_CODEX_CMD = nativeCommand;
    } else {
      // The HTTP contract runs on hosts without a Codex installation too.
      const active = path.join(home, 'sessions', '2026', '02', '11', name);
      await mkdir(path.dirname(active), { recursive: true });
      await rename(archived, active);
    }
    const restore = async () => {
      const response = await fetch(url + '/restore', { method: 'POST' });
      assert.equal(response.status, 200, await response.text());
      assert.equal(Boolean(sessionsDb.getSessionById(id)?.isArchived), false);
    };
    await restore();
    const result = await fetch(url + '/messages');
    const payload = await result.json() as { data: { messages: Array<{ content: string }> } };
    assert.equal(payload.data.messages[0].content, 'history through HTTP');
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 200);
    assert.ok(sessionsDb.getSessionById(id)?.isArchived);
    await restore();
    const restored = await (await fetch(url + '/messages')).json() as { data: { total: number } };
    assert.equal(restored.data.total, 1);
    assert.equal((await fetch(url + '?force=true', { method: 'DELETE' })).status, 200);
  });
});

test('synchronizeSessions keeps sessions whose whole transcript directory is missing', async () => {
  await withIsolatedDatabase(async (workspace) => {
    // Stands in for an unmounted or not-yet-created home: every transcript
    // "looks" deleted, so pruning here would wipe the entire index.
    const unmountedPath = path.join(workspace, 'not-mounted', 'session.jsonl');

    sessionsDb.createSession('unmounted-session', 'claude', PROJECT_PATH, 'Unmounted', undefined, undefined, unmountedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('unmounted-session'));
  });
});

test('synchronizeSessions keeps sessions that have no transcript path yet', async () => {
  await withIsolatedDatabase(async () => {
    // App-created rows (jsonl_path NULL until the first provider write) and
    // indexed rows whose transcript path was never recorded.
    sessionsDb.createAppSession('pending-app-session', 'claude', PROJECT_PATH, 'Pending');
    sessionsDb.createSession('pathless-session', 'claude', PROJECT_PATH, 'Pathless', undefined, undefined, null);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('pending-app-session'));
    assert.ok(sessionsDb.getSessionById('pathless-session'));
  });
});

test('Codex history survives unlink, native archival, compression and restart-style rescans until explicit deletion', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const home = process.env.AH_CODEX_HOME!;
    const id = '019c3333-4000-7000-8000-123456789abc';
    const directory = path.join(home, 'sessions', '2026', '02', '11');
    const name = 'rollout-2026-02-11T00-00-00-' + id + '.jsonl';
    const active = path.join(directory, name);
    const retained = path.join(home, 'agentharbor-history', name);
    const archive = path.join(home, 'archived_sessions', name);
    const timestamp = '2026-02-11T00:00:00.000Z';
    const meta = { type: 'session_meta', timestamp, payload: { id, cwd: workspace, timestamp, originator: 'codex_cli_rs', cli_version: '0.169.0', source: 'cli', model_provider: 'openai' } };
    const message = (text: string) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: text } }) + '\n';
    await mkdir(directory, { recursive: true });
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(active, JSON.stringify(meta) + '\n' + message('first turn'));
    sessionsDb.createAppSession('app-session', 'codex', workspace, 'Keep this');
    sessionsDb.assignProviderSessionId('app-session', id);

    await sessionSynchronizerService.synchronizeSessions();
    assert.equal(await readFile(retained, 'utf8'), await readFile(active, 'utf8'));
    await appendFile(active, message('second turn'));
    await sessionSynchronizerService.synchronizeProviderFile('codex', active);
    await unlink(active);
    const history = await sessionsService.fetchHistory('app-session');
    assert.deepEqual(history.messages.map((item) => item.content), ['first turn', 'second turn']);
    assert.equal(await readFile(active, 'utf8'), await readFile(retained, 'utf8'));

    await rename(active, archive);
    await sessionSynchronizerService.synchronizeSessions();
    assert.equal(sessionsDb.getSessionById('app-session')?.jsonl_path, archive);
    assert.ok(sessionsDb.getSessionById('app-session')?.isArchived);
    await assert.rejects(stat(active), { code: 'ENOENT' });
    const archivedText = await readFile(archive);
    await writeFile(archive + '.zst', zlib.zstdCompressSync(archivedText));
    await unlink(archive);
    await sessionSynchronizerService.synchronizeSessions();
    assert.equal(sessionsDb.getSessionById('app-session')?.jsonl_path, archive + '.zst');
    assert.equal((await sessionsService.fetchHistory('app-session')).total, 2);
    await unlink(archive + '.zst');
    assert.equal((await sessionsService.fetchHistory('app-session')).total, 2);
    assert.deepEqual(zlib.zstdDecompressSync(await readFile(archive + '.zst')), archivedText);
    await assert.rejects(stat(active), { code: 'ENOENT' });

    await sessionsService.deleteOrArchiveSessionById('app-session', { force: true, deletedFromDisk: true });
    await sessionSynchronizerService.synchronizeSessions();
    assert.equal(sessionsDb.getSessionByProviderSessionId(id), null);
    for (const deleted of [retained, archive, active, retained + '.zst', archive + '.zst']) {
      await assert.rejects(stat(deleted), { code: 'ENOENT' });
    }
  });
});

test('a Codex index row survives when the original disappeared before retention was installed', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const missing = path.join(workspace, 'unavailable.jsonl');
    sessionsDb.createSession('old-thread', 'codex', workspace, 'Preserved title', undefined, undefined, missing);
    assert.equal((await sessionSynchronizerService.synchronizeSessions()).prunedOrphans, 0);
    assert.equal(sessionsDb.getSessionById('old-thread')?.custom_name, 'Preserved title');
  });
});

test('filesystems without hard links keep an atomic copy and only recopy changed rollouts', async (t) => {
  const home = process.env.AH_CODEX_HOME!;
  const file = path.join(home, 'sessions', 'rollout-fallback.jsonl');
  const copy = path.join(home, 'agentharbor-history', path.basename(file));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'first\n');
  const realCopy = fs.copyFile.bind(fs);
  const copied = t.mock.method(fs, 'copyFile', realCopy);
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
  syncBuiltinESMExports();
  try {
    await retainSessionTranscript(file);
    await retainSessionTranscript(file);
    assert.equal(copied.mock.callCount(), 1);
    await appendFile(file, 'second\n');
    copied.mock.mockImplementationOnce(async (_source, target) => {
      await writeFile(target, 'partial');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    const warning = t.mock.method(console, 'warn', () => {});
    await retainSessionTranscript(file);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(await readFile(copy, 'utf8'), 'first\n');
    const later = Date.now() + 61_000;
    t.mock.method(Date, 'now', () => later);
    await retrySessionTranscriptRetention();
    assert.equal(await readFile(copy, 'utf8'), 'first\nsecond\n');
    await removeSessionTranscript(file);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
