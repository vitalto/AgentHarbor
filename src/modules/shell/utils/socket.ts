import { IS_PLATFORM } from '@/shared/utils';
import { getStoredAuthToken } from '@/shared/authToken';

// A session terminal attaches to the session's tmux window (sessionId); a
// plain shell attaches to the project's shell window (isPlainShell).
type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  sessionId: string | null;
  isPlainShell: boolean;
  cols: number;
  rows: number;
};

type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

type ShellInputMessage = {
  type: 'input';
  data: string;
};

type ShellOutgoingMessage = ShellInitMessage | ShellResizeMessage | ShellInputMessage;

type ShellIncomingMessage =
  | { type: 'output'; data: string }
  // Sent instead of attaching when the tmux window cannot be found or opened,
  // so this is the only signal that the terminal will never start.
  | { type: 'error'; message?: string }
  | { type: string; [key: string]: unknown };

export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (IS_PLATFORM) {
    return `${protocol}//${window.location.host}/shell`;
  }

  const token = getStoredAuthToken();
  if (!token) {
    console.error('No authentication token found for Shell WebSocket connection');
    return null;
  }

  return `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
