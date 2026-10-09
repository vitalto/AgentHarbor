import fsp from 'node:fs/promises';

import { AgentWindowError, findAgentWindow } from '@/modules/tmux/agent-windows.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';

/** Claude Code's permission modes, as its transcript names them. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

/** How the TUI's status line names each mode (Shift+Tab cycles bypass → auto → manual → accept edits → plan). */
const STATUS_LINE_MODES: Array<[RegExp, PermissionMode]> = [
  [/bypass permissions on/, 'bypassPermissions'],
  [/accept edits on/, 'acceptEdits'],
  [/plan mode on/, 'plan'],
  [/auto mode on/, 'auto'],
  [/manual mode on/, 'default'],
];

const MAX_CYCLE_PRESSES = 6;
const AFTER_PRESS_MS = 700;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The mode the status line shows, or null when it is off screen (e.g. covered by a list of agents). */
export function parseStatusLineMode(lines: string[]): PermissionMode | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    for (const [pattern, mode] of STATUS_LINE_MODES) {
      if (pattern.test(lines[index])) {
        return mode;
      }
    }
  }
  return null;
}

/** The last mode Claude recorded in the transcript (it writes one per turn). */
async function readTranscriptMode(transcriptPath: string | null): Promise<PermissionMode | null> {
  if (!transcriptPath) {
    return null;
  }
  try {
    const handle = await fsp.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const matches = [...buffer.toString('utf8').matchAll(/"type":"permission-mode","permissionMode":"(\w+)"/g)];
      return (matches.at(-1)?.[1] as PermissionMode | undefined) ?? null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function getPermissionMode(appSessionId: string): Promise<PermissionMode | null> {
  const pane = await findAgentWindow(appSessionId);
  if (!pane) {
    return null;
  }
  return parseStatusLineMode(await tmuxService.capturePane(pane.pane.paneId)) ?? readTranscriptMode(pane.transcriptPath);
}

/** Presses Shift+Tab in the session's window until its status line shows `target`. */
export async function setPermissionMode(appSessionId: string, target: PermissionMode): Promise<PermissionMode> {
  const pane = await findAgentWindow(appSessionId);
  if (!pane) {
    throw new AgentWindowError('This session has no Claude window.');
  }
  for (let press = 0; press <= MAX_CYCLE_PRESSES; press += 1) {
    const current = parseStatusLineMode(await tmuxService.capturePane(pane.pane.paneId));
    if (current === target) {
      return current;
    }
    if (current === null) {
      throw new AgentWindowError('The mode line is not on screen right now (Claude shows a menu or a list over it).');
    }
    if (press < MAX_CYCLE_PRESSES) {
      await tmuxService.sendKeys(pane.pane.paneId, ['BTab']);
      await delay(AFTER_PRESS_MS);
    }
  }
  throw new AgentWindowError(
    target === 'bypassPermissions'
      ? 'This Claude window was started without --dangerously-skip-permissions, so bypass is not offered.'
      : `Claude did not offer the "${target}" mode.`,
  );
}
