import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'question-session';

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

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.tui-keys with a questionStep switches the question; an unknown step falls back to whitelisted keys', async () => {
  const socket = createFakeSocket();
  const switched: Array<[string, string]> = [];
  const pressed: string[][] = [];
  try {
    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: { hasRuntime: () => true } as never,
        terminal: {
          switchQuestion: async (sessionId: string, step: string) => {
            switched.push([sessionId, step]);
            return true;
          },
          sendKeys: async (_sessionId: string, keys: string[]) => {
            pressed.push(keys);
            return true;
          },
        } as never,
      },
    );

    socket.emit('message', JSON.stringify({ type: 'chat.tui-keys', sessionId: SESSION_ID, questionStep: 'previous' }));
    socket.emit('message', JSON.stringify({ type: 'chat.tui-keys', sessionId: SESSION_ID, questionStep: 'next' }));
    socket.emit('message', JSON.stringify({ type: 'chat.tui-keys', sessionId: SESSION_ID, questionStep: 'sideways', keys: ['C-d', 'Escape'] }));
    await settle();

    assert.deepEqual(switched, [[SESSION_ID, 'previous'], [SESSION_ID, 'next']]);
    assert.deepEqual(pressed, [['Escape']]);
  } finally {
    connectedClients.clear();
  }
});
