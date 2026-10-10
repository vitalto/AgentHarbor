import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import { api } from '@/shared/api';

/** A command an agent queued with `elevate`; mirrors the server's ElevationRequest. */
type ElevationRequest = {
  id: string;
  command: string;
  cwd: string;
  requestedAt: string;
  sessionId: string | null;
  sessionTitle: string | null;
};

type ElevationQueueSnapshot = {
  brokerOnline: boolean;
  requests: ElevationRequest[];
};

const POLL_MS = 2000;

function useElevationQueue() {
  const [snapshot, setSnapshot] = useState<ElevationQueueSnapshot>({ brokerOnline: true, requests: [] });

  const refresh = useCallback(async () => {
    try {
      const response = await api.elevation.list();
      const body = (await response.json()) as { success?: boolean; data?: ElevationQueueSnapshot };
      if (body.success && body.data) {
        setSnapshot(body.data);
      }
    } catch {
      // Keep the last snapshot; the next poll retries.
    }
  }, []);

  useEffect(() => {
    const pollWhileVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    pollWhileVisible();
    const timer = window.setInterval(pollWhileVisible, POLL_MS);
    document.addEventListener('visibilitychange', pollWhileVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', pollWhileVisible);
    };
  }, [refresh]);

  return { snapshot, refresh };
}

function ElevationRequestCard({ request, brokerOnline, onDecided }: {
  request: ElevationRequest;
  brokerOnline: boolean;
  onDecided: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const decide = async (approved: boolean) => {
    setSending(true);
    setError('');
    try {
      const response = await api.elevation.decide(request.id, approved);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not send the answer');
      }
    } catch {
      setError('Could not send the answer');
    } finally {
      setSending(false);
      await onDecided();
    }
  };

  const sessionLabel = request.sessionTitle || (request.sessionId ? 'this session' : 'an agent');

  return (
    <div role="alertdialog" aria-label="Admin rights requested" className="rounded-lg border border-amber-500/40 bg-background p-3 text-sm shadow-xl">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            Admin rights requested by{' '}
            {request.sessionId ? (
              <button type="button" onClick={() => navigate(`/session/${request.sessionId}`)} className="underline decoration-dotted underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300">
                {sessionLabel}
              </button>
            ) : sessionLabel}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={request.cwd}>{request.cwd}</div>
        </div>
      </div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground">{request.command}</pre>
      {!brokerOnline && (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400">
          The elevation broker is not running, so an approval would not run anything yet. The agent's elevate restarts it within seconds; if this stays, check the scheduled task "Elevation broker" on the PC.
        </div>
      )}
      {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      <div className="mt-2.5 flex justify-end gap-2">
        <button type="button" disabled={sending} onClick={() => void decide(false)} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          Deny
        </button>
        <button type="button" disabled={sending || !brokerOnline} onClick={() => void decide(true)} className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
          Run as admin
        </button>
      </div>
    </div>
  );
}

/**
 * Rendered by the project workspace shell on every screen: an agent's `elevate` call blocks
 * until the user answers here, because a UAC prompt on the PC cannot be clicked remotely.
 */
export default function ElevationRequests() {
  const { snapshot, refresh } = useElevationQueue();

  if (snapshot.requests.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-3 z-[60] flex flex-col gap-2 sm:left-auto sm:right-4 sm:w-[28rem]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--keyboard-height, 0px) + 0.75rem)' }}
    >
      {snapshot.requests.map((request) => (
        <ElevationRequestCard key={request.id} request={request} brokerOnline={snapshot.brokerOnline} onDecided={refresh} />
      ))}
    </div>
  );
}
