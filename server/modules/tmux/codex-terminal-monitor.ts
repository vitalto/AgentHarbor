import { stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { findCodexWindow, inspectCodexWindow } from '@/modules/tmux/codex-windows.service.js';
import type { MonitorSocket } from '@/modules/tmux/session-monitor.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';
import { unreadablePrompt } from '@/modules/tmux/tui-prompt.js';

type ChatWatch = { sockets: Set<MonitorSocket>; prompt: string | null; output: string; size?: number };

/** Mirrors native menus and changes typed directly in the Codex terminal to subscribed web chats. */
export function createCodexTerminalMonitor(isProcessing: (appId: string) => boolean) {
  const watches = new Map<string, ChatWatch>();
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
        const prompt = state?.screen.activity === 'waiting'
          ? JSON.stringify({ kind: 'tui_prompt', sessionId: appId, prompt: unreadablePrompt(state.screen.lines) }) : null;
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
      const watch = watches.get(appId) ?? { sockets: new Set<MonitorSocket>(), prompt: null, output: '' };
      watch.sockets.add(socket);
      watches.set(appId, watch);
      if (watch.prompt && socket.readyState === 1) socket.send(watch.prompt);
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
