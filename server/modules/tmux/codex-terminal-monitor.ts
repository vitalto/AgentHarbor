import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { findCodexWindow, inspectCodexWindow } from '@/modules/tmux/codex-windows.service.js';
import type { MonitorSocket } from '@/modules/tmux/session-monitor.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';
import { keysForOption, keysToReachOption } from '@/modules/tmux/tui-prompt.js';

type ChatWatch = { sockets: Set<MonitorSocket>; prompt?: string | null; output: string; size?: number };

/** Mirrors native menus and changes typed directly in the Codex terminal to subscribed web chats. */
export function createCodexTerminalMonitor(isProcessing: (appId: string) => boolean) {
  const watches = new Map<string, ChatWatch>();
  const answering = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  const broadcast = (watch: ChatWatch, frame: string) => {
    for (const socket of watch.sockets) {
      if (socket.readyState === 1) socket.send(frame);
      else watch.sockets.delete(socket);
    }
  };

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const panes = await tmuxService.listPanes();
      await Promise.all([...watches].map(async ([appId, watch]) => {
        const owned = await findCodexWindow(appId, panes);
        const state = owned && await inspectCodexWindow(appId, owned.pane).catch(() => null);
        const prompt = state?.screen.dialog
          ? JSON.stringify({ kind: 'tui_prompt', sessionId: appId, prompt: state.screen.dialog }) : null;
        if (prompt !== watch.prompt) {
          watch.prompt = prompt;
          broadcast(watch, prompt ?? JSON.stringify({ kind: 'tui_prompt_cleared', sessionId: appId }));
        }
        const lines = state?.screen.output ?? [];
        const output = lines.join('\n');
        if (output !== watch.output) {
          watch.output = output;
          broadcast(watch, JSON.stringify({ kind: 'tui_screen', sessionId: appId, lines }));
        }
        const file = sessionsDb.getSessionById(appId)?.jsonl_path;
        const size = file && (await stat(file).catch(() => null))?.size;
        if (typeof size === 'number') {
          if (size !== watch.size && !isProcessing(appId)) {
            broadcast(watch, JSON.stringify({ kind: 'transcript_reset', sessionId: appId }));
          }
          watch.size = size;
        }
      }));
    } catch (error) {
      console.error('[AgentHarbor] Codex terminal monitor failed', error);
    } finally {
      ticking = false;
    }
  }

  return {
    viewers(appId: string) {
      return watches.get(appId)?.sockets ?? [];
    },
    watch(appId: string, socket: MonitorSocket) {
      const watch: ChatWatch = watches.get(appId) ?? { sockets: new Set<MonitorSocket>(), output: '' };
      watch.sockets.add(socket);
      watches.set(appId, watch);
      if (watch.prompt !== undefined && socket.readyState === 1) {
        socket.send(watch.prompt ?? JSON.stringify({ kind: 'tui_prompt_cleared', sessionId: appId }));
      }
      timer ??= setInterval(() => void tick(), 750).unref();
    },
    unwatchSocket(socket: MonitorSocket) {
      for (const [appId, watch] of watches) {
        watch.sockets.delete(socket);
        if (!watch.sockets.size) watches.delete(appId);
      }
      if (!watches.size) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    async focusQuestions(appId: string, open: boolean) {
      const owned = await findCodexWindow(appId);
      if (!owned || answering.has(appId)) return false;
      const { screen, providerSessionId } = await inspectCodexWindow(appId, owned.pane);
      if (!providerSessionId || providerSessionId !== owned.providerSessionId) return false;
      if (open && screen.dialog?.codexQuestionId) return true;
      if (open ? !screen.composer || !screen.pendingQuestionCount : !screen.dialog?.codexQuestionId) return false;
      await tmuxService.sendKeys(owned.pane.paneId, [open ? 'S-Left' : 'S-Right']);
      return true;
    },
    async chooseOption(appId: string, optionIndex: number, questionId?: string) {
      const owned = await findCodexWindow(appId);
      if (!owned || answering.has(appId)) return false;
      const { screen, providerSessionId } = await inspectCodexWindow(appId, owned.pane);
      const option = screen.dialog?.options[optionIndex];
      if (!screen.dialog || !Number.isInteger(optionIndex) || !option || screen.dialog.codexQuestionId !== questionId) return false;
      if (questionId) {
        if (!providerSessionId || providerSessionId !== owned.providerSessionId || option.freeText || answering.has(appId)) return false;
        answering.add(appId);
        try {
          const moves = keysToReachOption(screen.dialog, optionIndex);
          if (moves.length) await tmuxService.sendKeys(owned.pane.paneId, moves);
          const deadline = Date.now() + 1500;
          do {
            const current = await inspectCodexWindow(appId, owned.pane);
            const dialog = current.screen.dialog;
            if (current.providerSessionId !== providerSessionId || !dialog?.codexQuestionId || dialog.question !== screen.dialog.question) return false;
            if (dialog.options.some((choice) => choice.selected && choice.label === option.label)) {
              await tmuxService.sendKeys(owned.pane.paneId, ['Enter']);
              // Keep double taps out until the TUI has consumed this answer.
              do {
                await delay(50);
                const after = await inspectCodexWindow(appId, owned.pane);
                if (after.screen.dialog?.codexQuestionId !== dialog.codexQuestionId) break;
              } while (Date.now() < deadline);
              return true;
            }
            await delay(40);
          } while (Date.now() < deadline);
          return false;
        } finally {
          answering.delete(appId);
        }
      }
      await tmuxService.sendKeys(owned.pane.paneId, keysForOption(screen.dialog, optionIndex));
      return true;
    },
    async sendKeys(appId: string, keys: string[]) {
      const owned = await findCodexWindow(appId);
      if (!owned) return false;
      const { screen } = await inspectCodexWindow(appId, owned.pane);
      if (screen.activity !== 'waiting') return false;
      await tmuxService.sendKeys(owned.pane.paneId, keys);
      return true;
    },
  };
}
