import { sessionsDb } from '@/modules/database/index.js';
import { listRunningBackgroundCommands } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  applyAgentSelection,
  ensureAgentWindow,
  findSessionHolders,
  getSessionMonitor,
  stageAttachmentForClaude,
  stopBackgroundCommand,
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

/** Types a message with its uploads into a Claude window: images as `[Image #N]` attachments, other files named in a <files_input> block. */
export async function typePromptWithAttachments(
  paneId: string,
  command: string,
  attachments: { images?: unknown; files?: unknown },
): Promise<void> {
  const images = await stageForClaude(attachments.images);
  // The <files_input> block names each file; chat history turns it back into file chips.
  const prompt = appendFilesInputTag(command, await stageForClaude(attachments.files));
  await typeIntoAgent(paneId, prompt, images.map((image) => image.path));
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
      await applyAgentSelection(appSessionId, pane.pane, { model: options.model, effort: options.effort });
      const turnEnded = getSessionMonitor().beginTurn(appSessionId);
      await typePromptWithAttachments(pane.pane.paneId, command, options);
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

  /** Only backgrounded commands: the TUI offers no way to stop one agent, and its shells are plain child processes. */
  async stopBackgroundTask(sessionId: string, taskId: string) {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.jsonl_path || !session.provider_session_id) {
      return false;
    }
    const holders = await findSessionHolders(session.provider_session_id);
    const liveRunStartedAt = Math.min(...holders.map((holder) => holder.startedAt ?? Number.POSITIVE_INFINITY));
    const commands = await listRunningBackgroundCommands(
      session.jsonl_path,
      session.provider_session_id,
      Number.isFinite(liveRunStartedAt) ? liveRunStartedAt : null,
    );
    const command = commands.find((candidate) => candidate.taskId === taskId);
    return command ? stopBackgroundCommand(holders, command.command) : false;
  },
};
