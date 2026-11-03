import { useEffect } from 'react';

/** The server forgets a report after 90 s, so a page that stays on a chat repeats it well within that. */
const VIEWING_REPORT_INTERVAL_MS = 30_000;

type ReportViewedChatOptions = {
  sendMessage: (message: unknown) => void;
  viewedSessionId: string | null;
  /** The chat panel is the workspace's current view (not the files or shell tab). */
  isActive: boolean;
  isConnected: boolean;
};

/**
 * Used by ChatInterface: tells the server which chat this page has on screen, so pushes about it
 * are held back on every device while the user reads it. Reported again on every change of chat,
 * visibility or connection, and every 30 s while it lasts.
 */
export function useReportViewedChat({ sendMessage, viewedSessionId, isActive, isConnected }: ReportViewedChatOptions): void {
  useEffect(() => {
    if (!isConnected) {
      return undefined;
    }
    const report = () => {
      const visible = isActive && Boolean(viewedSessionId) && document.visibilityState === 'visible';
      sendMessage({ type: 'chat.viewing', sessionId: viewedSessionId, visible });
    };
    report();
    const interval = window.setInterval(report, VIEWING_REPORT_INTERVAL_MS);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', report);
      sendMessage({ type: 'chat.viewing', sessionId: null, visible: false });
    };
  }, [sendMessage, viewedSessionId, isActive, isConnected]);
}
