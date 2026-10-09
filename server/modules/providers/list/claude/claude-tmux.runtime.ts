import {
  ensureAgentWindow,
  getSessionMonitor,
  toClaudePath,
  typeIntoAgent,
  waitForInputReady,
} from '@/modules/tmux/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

function readAttachmentPaths(options: AnyRecord): string[] {
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  return attachments
    .map((attachment) => (attachment && typeof attachment.path === 'string' ? attachment.path : null))
    .filter((attachmentPath): attachmentPath is string => Boolean(attachmentPath));
}

/** Claude's TUI attaches an image when its file path is part of the prompt. */
export function composePrompt(command: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) {
    return command;
  }
  const claudePaths = attachmentPaths.map((attachmentPath) => toClaudePath(attachmentPath));
  return `${command}\n\n${claudePaths.join(' ')}`;
}

/**
 * Drives the session's interactive Claude Code TUI in tmux instead of
 * spawning an SDK run: the prompt is typed into the window, and the session
 * monitor streams the resulting transcript rows and ends the turn when Claude
 * goes idle.
 */
export const claudeTmuxRuntime: IProviderRuntime = {
  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter) {
    const appSessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    if (!appSessionId) {
      throw new Error('claude tmux runtime requires a session id');
    }

    try {
      const pane = await ensureAgentWindow(appSessionId);
      await waitForInputReady(appSessionId, pane.pane.paneId);
      const turnEnded = getSessionMonitor().beginTurn(appSessionId);
      await typeIntoAgent(pane.pane.paneId, composePrompt(command, readAttachmentPaths(options)));
      return await turnEnded;
    } catch (error) {
      writer.send(createNormalizedMessage({
        kind: 'error',
        content: error instanceof Error ? error.message : String(error),
        sessionId: appSessionId,
        provider: 'claude',
      }));
      throw error;
    }
  },

  async abort(sessionId: string) {
    return getSessionMonitor().sendKeys(sessionId, ['Escape']);
  },
};
