import { setTimeout as delay } from 'node:timers/promises';

import { AgentWindowError } from '@/modules/tmux/agent-windows.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';

type PaneCapture = Awaited<ReturnType<typeof tmuxService.inspectPane>>;
const sgr = /\x1b\[[0-9;:]*m/g;

/** Used by the Codex window registry, input driver and chat watcher to interpret the same pane capture. */
export function parseCodexScreen(capture: PaneCapture) {
  if (capture.dead) throw new AgentWindowError('The Codex terminal closed.');
  const lines = capture.lines.map((line) => line.replace(sgr, '').trimEnd());
  let prompt = capture.cursorY;
  while (prompt >= 0 && !/^›(?:\s|$)/u.test(lines[prompt] ?? '')) prompt--;
  const bottom = lines.filter((line) => line.trim()).slice(-2).join(' ');
  const menu = /(?:enter|return) (?:to )?(?:select|confirm|continue|submit)|esc (?:to )?(?:cancel|go back|skip|dismiss)/i.test(bottom);
  const composer = capture.cursorVisible && prompt >= 0 && !menu;
  const placeholder = composer && /^\s*(?:\x1b\[[\d;:]*m)*›(?:\x1b\[[\d;:]*m)*\s+\x1b\[(?:[\d;]*;)?2(?:;[\d;]*)?m/u.test(capture.lines[prompt]);
  const empty = composer && capture.cursorX === 2 && capture.cursorY === prompt
    && (placeholder || lines[prompt] === '›');
  const working = composer && lines.slice(Math.max(0, prompt - 6), prompt + 1).some((line) => /esc to interrupt/i.test(line));
  return {
    title: capture.title, lines, composer, empty,
    output: working ? lines.slice(0, prompt).filter((line) => line.trim()).slice(-14) : [],
    input: composer ? lines.slice(prompt, capture.cursorY + 1).join('\n') : '',
    activity: menu ? 'waiting' as const : working ? 'working' as const : empty ? 'idle' as const : 'unknown' as const,
  };
}

/** Used by the Codex runtime and window registry to inspect a live TUI without changing it. */
export async function readCodexScreen(paneId: string) {
  return parseCodexScreen(await tmuxService.inspectPane(paneId));
}

type Screen = ReturnType<typeof parseCodexScreen>;

async function waitForScreen(paneId: string, accepts: (screen: Screen) => boolean, error: string) {
  const deadline = Date.now() + 3000;
  do {
    const screen = await readCodexScreen(paneId);
    if (accepts(screen)) return screen;
    await delay(50);
  } while (Date.now() < deadline);
  throw new AgentWindowError(error);
}

/** Types one web message (or session-local slash command) into the Codex composer. */
export async function typeCodexInput(paneId: string, text: string, imagePaths: string[], expectedTitle: string, signal?: AbortSignal) {
  const first = await readCodexScreen(paneId);
  if (first.title !== expectedTitle || !first.empty) {
    throw new AgentWindowError('Open Terminal and finish the Codex dialog or draft before sending.');
  }
  if (!text.trim() && !imagePaths.length) throw new AgentWindowError('The Codex message is empty.');
  let lastInput = first.input;
  for (const imagePath of imagePaths) {
    signal?.throwIfAborted();
    await tmuxService.pasteText(paneId, imagePath);
    const attached = await waitForScreen(paneId, (screen) => screen.title === expectedTitle && screen.input !== lastInput
      && /\[Image #\d+\]\s*$/i.test(screen.input), 'Codex could not attach this image. Review the draft in Terminal.');
    lastInput = attached.input;
  }
  if (text.trim()) {
    signal?.throwIfAborted();
    await tmuxService.pasteText(paneId, text);
    await waitForScreen(paneId, (screen) => screen.title === expectedTitle && screen.composer && !screen.empty && screen.input !== lastInput,
      'Codex did not accept the paste. Review the draft in Terminal.');
  }
  signal?.throwIfAborted();
  await tmuxService.sendKeys(paneId, ['Enter']);
}
