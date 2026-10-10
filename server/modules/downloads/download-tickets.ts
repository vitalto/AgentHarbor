import { randomBytes } from 'node:crypto';

type IssuedTicket = {
  localPath: string;
  expiresAt: number;
};

export type DownloadTicketStore = {
  issue(localPath: string): string;
  /** Returns the ticket's file at most once; an unknown, used or expired ticket yields null. */
  redeem(ticket: string): string | null;
};

const DEFAULT_TICKET_LIFETIME_MS = 60_000;

// Tickets live only in memory: a server restart invalidates every outstanding
// link, which is fine because the browser redeems a ticket right after issuing it.
export function createDownloadTicketStore({
  lifetimeMs = DEFAULT_TICKET_LIFETIME_MS,
  now = Date.now,
}: { lifetimeMs?: number; now?: () => number } = {}): DownloadTicketStore {
  const tickets = new Map<string, IssuedTicket>();

  const dropExpiredTickets = () => {
    const currentTime = now();
    for (const [ticket, issued] of tickets) {
      if (issued.expiresAt <= currentTime) {
        tickets.delete(ticket);
      }
    }
  };

  return {
    issue(localPath) {
      dropExpiredTickets();
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(ticket, { localPath, expiresAt: now() + lifetimeMs });
      return ticket;
    },
    redeem(ticket) {
      const issued = tickets.get(ticket);
      tickets.delete(ticket);
      if (!issued || issued.expiresAt <= now()) {
        return null;
      }
      return issued.localPath;
    },
  };
}
