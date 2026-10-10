import {
  ensureAgentWindow,
  getSessionMonitor,
  stageAttachmentForClaude,
  typeIntoAgent,
  waitForInputReady,
} from '@/modules/tmux/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/types.js';
import { appendFilesInputTag, normalizeAttachmentDescriptors, type ChatAttachmentDescriptor } from '@/shared/image-attachments.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/** The uploads as Claude should be given them: copied where a Windows Claude can reach them, original names kept. */
function stageForClaude(attachments: unknown): Promise<ChatAttachmentDescriptor[]> {
  return Promise.all(normalizeAttachmentDescriptors(attachments).map(async (descriptor) => ({
    ...descriptor,
    path: await stageAttachmentForClaude(descriptor.path),
  })));
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
      const images = await stageForClaude(options.images);
      // The <files_input> block names each file; chat history turns it back into file chips.
      const prompt = appendFilesInputTag(command, await stageForClaude(options.files));
      const turnEnded = getSessionMonitor().beginTurn(appSessionId);
      await typeIntoAgent(pane.pane.paneId, prompt, images.map((image) => image.path));
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
