import { keysForOption, parseTuiPrompt, trustFolderOptionIndex } from '@/modules/tmux/tui-prompt.js';

/** A window being started that sits on Claude's folder-trust dialog, which only the user may answer; the notifications module pushes it. */
export type FolderTrustRequest = {
  appSessionId: string;
  /** The folder Claude asks to trust, as its dialog names it (a Windows path for a Windows Claude). */
  folder: string;
};

type FolderTrustListener = (request: FolderTrustRequest) => void | Promise<void>;

const folderTrustListeners = new Set<FolderTrustListener>();

/**
 * Used by the notifications module to push "trust the folder" to the user: a session started
 * without anyone watching (`ah new`) would otherwise wait on the dialog unseen until it times out.
 * Returns a function that removes the listener.
 */
export function onFolderTrustRequested(listener: FolderTrustListener): () => void {
  folderTrustListeners.add(listener);
  return () => folderTrustListeners.delete(listener);
}

function announceFolderTrustRequest(request: FolderTrustRequest): void {
  for (const listener of folderTrustListeners) {
    Promise.resolve()
      .then(() => listener(request))
      .catch((error) => console.error('[AgentHarbor] folder trust listener failed', error));
  }
}

/** Sessions whose starter (`ah new --trust-folder`) vouched for the project folder; each entry covers one window start. */
const sessionsTrustedForNextStart = new Set<string>();

/**
 * Used by the providers module when `POST /api/providers/sessions` carries `trustFolder: true`:
 * the next window started for the session answers the folder-trust dialog itself. The caller has
 * checked the folder, so its hooks and MCP servers may run. Kept in memory only: the start follows
 * within seconds, and a vouch should not outlive the server that was given it.
 */
export function trustFolderOnNextStart(appSessionId: string): void {
  sessionsTrustedForNextStart.add(appSessionId);
}

/** Used by agent-windows.service when it starts a window: whether that start may trust the folder, used up by asking. */
export function takeFolderTrustForStart(appSessionId: string): boolean {
  return sessionsTrustedForNextStart.delete(appSessionId);
}

/** Used by agent-windows.service to fail a start that timed out on the trust dialog with what the user has to do. */
export function folderTrustTimeoutMessage(folder: string): string {
  return `Claude is waiting for you to trust the folder ${folder}; open the session to answer, `
    + 'or start it with `ah new --trust-folder` if you have checked the folder.';
}

/**
 * Used by agent-windows.service while a window waits for registration: follows its screen for
 * Claude's folder-trust dialog. With `answerForUser` the dialog is answered: in the Claude user's
 * home folder (Claude asks there on every start and never stores the answer) and for a start whose
 * caller vouched for the folder. Anywhere else trusting could run a cloned repo's hooks or MCP
 * servers unreviewed, so the user is asked instead, once per window start.
 */
export function createFolderTrustWatch(request: FolderTrustRequest & { answerForUser: boolean }) {
  let userAsked = false;
  let awaitingUser = false;
  return {
    /** Keys to type into the pane for this screen; empty when there is nothing to answer. */
    observe(screen: string[]): string[] {
      const prompt = parseTuiPrompt(screen);
      const trustIndex = trustFolderOptionIndex(prompt);
      awaitingUser = false;
      if (!prompt || trustIndex < 0) {
        return [];
      }
      if (request.answerForUser) {
        return keysForOption(prompt, trustIndex);
      }
      awaitingUser = true;
      if (!userAsked) {
        userAsked = true;
        announceFolderTrustRequest({ appSessionId: request.appSessionId, folder: request.folder });
      }
      return [];
    },

    /** The last screen seen showed the trust dialog, left for the user to answer. */
    isAwaitingUser(): boolean {
      return awaitingUser;
    },
  };
}

export type FolderTrustWatch = ReturnType<typeof createFolderTrustWatch>;
