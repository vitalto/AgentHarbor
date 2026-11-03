import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: unknown[]; send: (data: string) => void };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data));
  return socket;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.viewing reports the chat on screen, a hidden page as none, and forgets the page when it disconnects', async () => {
  const socket = createFakeSocket();
  const reports: Array<{ userId: number | null; sessionId: string | null }> = [];
  const forgotten: unknown[] = [];
  try {
    handleChatConnection(socket as never, { user: { id: '7' } } as never, {
      runtime: { hasRuntime: () => true } as never,
      viewers: {
        report: (connection, viewer) => {
          assert.equal(connection, socket);
          reports.push(viewer);
        },
        forget: (connection) => forgotten.push(connection),
      },
    });

    socket.emit('message', JSON.stringify({ type: 'chat.viewing', sessionId: 'chat-a', visible: true }));
    socket.emit('message', JSON.stringify({ type: 'chat.viewing', sessionId: 'chat-a', visible: false }));
    socket.emit('message', JSON.stringify({ type: 'chat.viewing', sessionId: null, visible: true }));
    await settle();
    socket.emit('close');

    assert.deepEqual(reports, [
      { userId: 7, sessionId: 'chat-a' },
      { userId: 7, sessionId: null },
      { userId: 7, sessionId: null },
    ]);
    assert.deepEqual(forgotten, [socket]);
    assert.deepEqual(socket.frames, [], 'no reply and no protocol error');
  } finally {
    connectedClients.clear();
  }
});
