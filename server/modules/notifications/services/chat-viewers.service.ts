/**
 * Which chats the user has on screen right now, as their open pages report it. A push about a
 * chat the user is reading only repeats what they already see, on whichever device it lands.
 */

/** Pages repeat their report every 30 s while visible; a report this old belongs to a page that went away without saying so. */
const VIEWER_REPORT_FRESH_MS = 90_000;

type ChatViewer = { userId: number; sessionId: string; reportedAt: number };

const viewersByConnection = new Map<object, ChatViewer>();

/**
 * Used by the websocket module for each `chat.viewing` frame: `sessionId` is the chat the page shows,
 * or null when it shows none or is hidden.
 */
export function reportChatViewer(
  connection: object,
  viewer: { userId: number | null; sessionId: string | null },
  now: number = Date.now(),
): void {
  if (viewer.userId === null || !viewer.sessionId) {
    viewersByConnection.delete(connection);
    return;
  }
  viewersByConnection.set(connection, { userId: viewer.userId, sessionId: viewer.sessionId, reportedAt: now });
}

/** Used by the websocket module when a page's connection closes. */
export function forgetChatViewer(connection: object): void {
  viewersByConnection.delete(connection);
}

/** Used by the notification orchestrator to hold back pushes about a chat some page of the user shows. */
export function isChatOnScreen(userId: number, sessionId: string, now: number = Date.now()): boolean {
  for (const viewer of viewersByConnection.values()) {
    if (viewer.userId === userId && viewer.sessionId === sessionId && now - viewer.reportedAt <= VIEWER_REPORT_FRESH_MS) {
      return true;
    }
  }
  return false;
}
