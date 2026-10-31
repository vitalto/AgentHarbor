import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createFolderTrustWatch,
  folderTrustTimeoutMessage,
  onFolderTrustRequested,
  takeFolderTrustForStart,
  trustFolderOnNextStart,
  type FolderTrustRequest,
} from '@/modules/tmux/folder-trust.js';

const fixturesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const screen = (name: string) => readFileSync(path.join(fixturesDirectory, `${name}.txt`), 'utf8').split('\n');

/** Listeners run on a later microtask, so the test lets them catch up before reading what they got. */
function recordRequests(t: test.TestContext): FolderTrustRequest[] {
  const requests: FolderTrustRequest[] = [];
  t.after(onFolderTrustRequested((request) => {
    requests.push(request);
  }));
  return requests;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a trust dialog left to the user is reported once per start, and the watch knows it waits on it', async (t) => {
  const requests = recordRequests(t);
  const watch = createFolderTrustWatch({ appSessionId: 'app1', folder: 'D:\\Develop\\Cloned', answerForUser: false });

  assert.deepEqual(watch.observe(screen('trust-folder')), [], 'nothing is typed for the user');
  assert.deepEqual(watch.observe(screen('trust-folder-moved')), []);
  await settle();

  assert.deepEqual(requests, [{ appSessionId: 'app1', folder: 'D:\\Develop\\Cloned' }]);
  assert.equal(watch.isAwaitingUser(), true);
});

test('the watch stops waiting on the user once the dialog leaves the screen', async (t) => {
  recordRequests(t);
  const watch = createFolderTrustWatch({ appSessionId: 'app1', folder: '/work/cloned', answerForUser: false });
  watch.observe(screen('trust-folder'));
  watch.observe(screen('idle-input'));
  assert.equal(watch.isAwaitingUser(), false);
});

test('a trust dialog the server may answer is answered with "Yes, I trust this folder" and nobody is asked', async (t) => {
  const requests = recordRequests(t);
  const watch = createFolderTrustWatch({ appSessionId: 'app1', folder: '/home/vital', answerForUser: true });

  assert.deepEqual(watch.observe(screen('trust-folder')), ['Down', 'Enter']);
  await settle();

  assert.deepEqual(requests, []);
  assert.equal(watch.isAwaitingUser(), false);
});

test('other menus on a starting window are neither answered nor reported as a trust request', async (t) => {
  const requests = recordRequests(t);
  const watch = createFolderTrustWatch({ appSessionId: 'app1', folder: '/work/cloned', answerForUser: true });

  for (const name of ['bash-permission', 'ask-question', 'idle-input']) {
    assert.deepEqual(watch.observe(screen(name)), [], name);
  }
  const userWatch = createFolderTrustWatch({ appSessionId: 'app1', folder: '/work/cloned', answerForUser: false });
  userWatch.observe(screen('bash-permission'));
  await settle();

  assert.deepEqual(requests, []);
  assert.equal(userWatch.isAwaitingUser(), false);
});

test('a failing listener does not break the start that reported the dialog', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.after(onFolderTrustRequested(() => {
    throw new Error('push service down');
  }));
  const requests = recordRequests(t);
  const watch = createFolderTrustWatch({ appSessionId: 'app1', folder: '/work/cloned', answerForUser: false });

  assert.doesNotThrow(() => watch.observe(screen('trust-folder')));
  await settle();
  assert.equal(requests.length, 1);
});

test('a vouch for the folder covers exactly one window start of that session', () => {
  trustFolderOnNextStart('vouched');
  assert.equal(takeFolderTrustForStart('other'), false);
  assert.equal(takeFolderTrustForStart('vouched'), true);
  assert.equal(takeFolderTrustForStart('vouched'), false, 'a second start asks again');
});

test('the timeout message names the folder and both ways out', () => {
  const message = folderTrustTimeoutMessage('D:\\Develop\\Cloned');
  assert.match(message, /^Claude is waiting for you to trust the folder D:\\Develop\\Cloned; open the session to answer/);
  assert.match(message, /`ah new --trust-folder`/);
});
