import { execFile, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import type { Socket } from 'node:net';

import { WebSocket } from 'ws';

import type { AnyRecord } from '@/shared/index.js';
import { getCodexCliConfig } from '@/modules/tmux/codex-cli.js';

type Notification = (method: string, params: AnyRecord) => void;

async function connectProxy() {
  const { executable, env } = getCodexCliConfig();
  const child = spawn(executable, ['app-server', 'proxy'], {
    env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  // The proxy forwards the WebSocket handshake and frames over stdio, including across WSL interop.
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.on('error', (error) => transport.destroy(error));
  const socket = new WebSocket('ws://localhost/', {
    createConnection: () => transport as Socket, handshakeTimeout: 5000, perMessageDeflate: false,
  });
  const pending = new Map<number, { resolve: (data: AnyRecord) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let listener: Notification | undefined;
  let disconnected: ((error: Error) => void) | undefined;
  const close = () => { socket.terminate(); child.kill(); };
  socket.on('error', () => {});
  socket.on('close', () => {
    child.kill();
    const error = new Error('Disconnected from the local Codex app server.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    disconnected?.(error);
  });
  socket.on('message', (raw) => {
    let frame: AnyRecord;
    try { frame = JSON.parse(raw.toString()); } catch { close(); return; }
    if (typeof frame.method === 'string') {
      // Interactive requests are answered by the attached Codex TUI.
      listener?.(frame.method, frame.params ?? {});
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(String(frame.error.message || 'Codex request failed.')));
    else entry.resolve(frame.result ?? {});
  });
  const request = (method: string, params: AnyRecord): Promise<AnyRecord> => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Codex app server is disconnected.'));
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex timed out servicing ${method}.`));
    }, 30_000);
    pending.set(id, {
      resolve: (data) => { clearTimeout(timeout); resolve(data); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await request('initialize', { clientInfo: { name: 'agentharbor', version: '1' }, capabilities: {} });
    socket.send(JSON.stringify({ method: 'initialized' }));
  } catch (error) { close(); throw error; }
  return {
    request, close,
    observe: (onNotification: Notification, onDisconnect: (error: Error) => void) => {
      listener = onNotification; disconnected = onDisconnect;
    },
  };
}

let startingDaemon: Promise<unknown> | null = null;

export async function connectCodexDaemon(startIfMissing = false) {
  try { return await connectProxy(); } catch (error) {
    if (!startIfMissing) throw error;
  }
  const { executable, env } = getCodexCliConfig();
  startingDaemon ??= promisify(execFile)(executable, ['app-server', 'daemon', 'start'], {
    env, windowsHide: true, timeout: 45_000,
  }).finally(() => { startingDaemon = null; });
  await startingDaemon;
  return connectProxy();
}
