import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, type BusySendAttachments } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'busy-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type BusyTyping = { sessionId: string; text: string; attachments: BusySendAttachments };

/** A session whose turn is still running, so a send goes into Claude's queue instead of starting a run. */
async function withBusySession(
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; typed: BusyTyping[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-while-busy-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const typed: BusyTyping[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    assert.ok(chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: 'native-1',
      connection: null,
      userId: 1,
    }));

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: { hasRuntime: () => true } as never,
        terminal: {
          typeWhileBusy: async (sessionId: string, text: string, attachments: BusySendAttachments) => {
            typed.push({ sessionId, text, attachments });
            return true;
          },
        } as never,
      },
    );

    await runTest({ socket, typed });
  } finally {
    connectedClients.clear();
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

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a photo sent without text while Claude is busy reaches its window', async () => {
  await withBusySession(async ({ socket, typed }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '',
      options: { attachments: [{ path: '1791664206507-279780044-photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg' }] },
    }));
    await settle();

    assert.equal(typed.length, 1);
    assert.equal(typed[0].text, '');
    assert.deepEqual(typed[0].attachments.images.map((image) => image.path), ['1791664206507-279780044-photo.jpg']);
    assert.deepEqual(typed[0].attachments.files, []);
  });
});

test('a busy send keeps files apart from images and drops paths outside the upload store', async () => {
  await withBusySession(async ({ socket, typed }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'look at these',
      options: {
        attachments: [
          { path: '1-a.png', name: 'a.png', mimeType: 'image/png' },
          { path: '2-notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
          { path: '/etc/passwd', name: 'passwd' },
        ],
      },
    }));
    await settle();

    assert.equal(typed.length, 1);
    assert.equal(typed[0].text, 'look at these');
    assert.deepEqual(typed[0].attachments.images.map((image) => image.path), ['1-a.png']);
    assert.deepEqual(typed[0].attachments.files.map((file) => file.path), ['2-notes.txt']);
  });
});
