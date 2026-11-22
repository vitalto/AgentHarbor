import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { AgentWindowError } from '@/modules/tmux/agent-windows.service.js';
import { readCodexBackgroundTerminalCount } from '@/modules/tmux/codex-background-terminals.js';
import { pasteCodexText } from '@/modules/tmux/codex-cli.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';
import { unreadablePrompt, type TuiPrompt } from '@/modules/tmux/tui-prompt.js';

type PaneCapture = Awaited<ReturnType<typeof tmuxService.inspectPane>>;
const sgr = /\x1b\[[0-9;:]*m/g;
// Codex keeps Enter mapped to newline for 120 ms after a paste burst, even after rendering it.
const pasteSettleMs = 150;

function readFolderAccessPrompt(lines: string[]): TuiPrompt | null {
  const rows = lines.map((line) => line.trim());
  const title = rows.lastIndexOf('Folder access');
  if (title < 0) return null;
  const sections = rows.slice(title + 1).join('\n').trim().split(/\n{2,}/);
  const footer = sections.pop();
  const choices = sections.pop()?.split('\n') ?? [];
  const description = sections.pop();
  const question = 'Trust this folder?';
  if (!/^enter continue\s*(?:·\s*)?esc back$/i.test(footer ?? '') || !sections[0]
    || !description?.startsWith(question) || choices.length !== 2) return null;

  const labels = ['Trust and continue', 'Back to Agent Command Center'];
  if (!labels.every((label, index) => choices[index].replace(/^›\s*/, '') === `${index + 1}. ${label}`)) return null;
  const options = labels.map((label, index) => ({
    label, selected: choices[index].startsWith('›'), detail: null, checked: null, freeText: false, confirmsSelection: false,
  }));
  if (options.filter((option) => option.selected).length !== 1) return null;

  const explanation = description.slice(question.length).trim().replace(/\n/g, ' ');
  return { question, body: [...sections, explanation].filter(Boolean), options,
    preview: [], questionTabs: false, safeguardPause: false, unreadable: false };
}

function readComposerStatus(lines: string[], prompt: number) {
  // The follow-up queue sits between the live status and the composer and can span any number of rows.
  let row = prompt - 1;
  while (row >= 0 && (!lines[row] || /^\s/.test(lines[row]))) row--;
  const hasQueue = lines[row] === '• Queued follow-up inputs';
  const end = hasQueue ? row : prompt;
  const queue = hasQueue ? lines.slice(row + 1, prompt).join('\n') : '';
  const pendingQuestionCount = [...queue.matchAll(/^  \? (\d+) questions?\s+(?:·\s*)?shift\+(?:←|left) to answer\s*$/gim)]
    .reduce((total, match) => total + Number(match[1]), 0);
  const status = lines.slice(Math.max(0, end - 6), end).reverse().find((line) => /esc to interrupt/i.test(line));
  const timing = status?.match(/^\s*(?:[•◦·✶]\s+)?([^()]+?)\s+\((?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?\s*[•·]\s*esc to interrupt\)/i);
  const turnStatus = timing && timing.slice(2).some(Boolean) ? {
    label: timing[1].trim(),
    elapsedSeconds: Number(timing[2] || 0) * 3600 + Number(timing[3] || 0) * 60 + Number(timing[4] || 0),
  } : null;
  return { working: Boolean(status), pendingQuestionCount, turnStatus };
}

function readQuestionDrawer(lines: string[], footer: string): TuiPrompt | null {
  if (!/shift\+(?:→|right)\s+main prompt/i.test(footer)) return null;
  const help = lines.map((line) => /shift\+(?:→|right)\s+main prompt/i.test(line)).lastIndexOf(true);
  let end = help;
  while (end > 0 && /(?:enter\s+submit|ctrl\+\]\s+skip|option\s+\d+\/\d+)/i.test(lines[end - 1])) end--;
  // The drawer is inset by two columns. Scrollback and the live turn spinner
  // can remain above it and change while the same question is on screen.
  let start = end;
  while (start > 0 && (!lines[start - 1] || lines[start - 1].startsWith('  '))) start--;
  const body = lines.slice(start, end);
  const optionPattern = /^\s*(›\s+)?(\d+)\.\s+(.+)$/u;
  const firstOption = body.findIndex((line) => optionPattern.test(line));
  const firstInput = firstOption < 0 ? body.findIndex((line) => /^\s*›/u.test(line)) : firstOption;
  const titleLines = body.slice(0, firstInput < 0 ? body.length : firstInput);
  const question = titleLines.map((line) => line.trim()).join('\n').trim().split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, ' ')).join('\n\n');
  const choices: { number: number; label: string; selected: boolean }[] = [];
  for (const line of firstOption < 0 ? [] : body.slice(firstOption)) {
    const match = optionPattern.exec(line);
    if (match) choices.push({ number: Number(match[2]), label: match[3].trim(), selected: Boolean(match[1]) });
    else if (line.trim() && choices.length) choices[choices.length - 1].label += ' ' + line.trim();
  }
  const canChoose = Boolean(question) && choices.filter((choice) => choice.selected).length === 1
    && new Set(choices.map((choice) => choice.label)).size === choices.length
    && choices.every((choice, index) => choice.number === choices[0].number + index);
  const options = canChoose ? choices.map(({ label, selected }) => ({
    label, selected, detail: null, freeText: label === 'Other', checked: null, confirmsSelection: false,
  })) : [];
  const codexQuestionId = createHash('sha256').update(JSON.stringify([question, choices.map(({ number, label }) => [number, label])])).digest('hex');
  return { codexQuestionId, question, options, body: question ? [] : body,
    questionTabs: false, safeguardPause: false, preview: [], unreadable: false };
}

/** Used by the Codex window registry, input driver and chat watcher to interpret the same pane capture. */
export function parseCodexScreen(capture: PaneCapture) {
  if (capture.dead) throw new AgentWindowError('The Codex terminal closed.');
  const lines = capture.lines.map((line) => line.replace(sgr, '').trimEnd());
  let prompt = capture.cursorY;
  while (prompt >= 0 && !/^›(?:\s|$)/u.test(lines[prompt] ?? '')) prompt--;
  // A pasted terminal transcript can contain the exact menu hints inside the editable draft.
  const footerRows = capture.cursorVisible && prompt >= 0 ? lines.slice(capture.cursorY + 1) : lines;
  const bottom = footerRows.filter((line) => line.trim()).slice(-2).join(' ');
  const questionDrawer = readQuestionDrawer(lines, bottom);
  const menu = Boolean(questionDrawer) || /(?:enter|return) (?:to )?(?:select|confirm|continue|submit)|esc (?:to )?(?:cancel|go back|skip|dismiss)/i.test(bottom);
  const composer = capture.cursorVisible && prompt >= 0 && !menu;
  const placeholder = composer && /^\s*(?:\x1b\[[\d;:]*m)*›(?:\x1b\[[\d;:]*m)*\s+\x1b\[(?:[\d;]*;)?2(?:;[\d;]*)?m/u.test(capture.lines[prompt]);
  const empty = composer && capture.cursorX === 2 && capture.cursorY === prompt
    && (placeholder || lines[prompt] === '›');
  const { working, pendingQuestionCount, turnStatus } = composer ? readComposerStatus(lines, prompt)
    : { working: false, pendingQuestionCount: 0, turnStatus: null };
  return {
    title: capture.title, lines, composer, empty, pendingQuestionCount, turnStatus,
    diagnostics: {
      cursorVisible: capture.cursorVisible, cursorX: capture.cursorX, cursorY: capture.cursorY,
      composerPromptRow: prompt, rowCount: lines.length,
      interruptHintRow: lines.findIndex((line) => /esc to interrupt/i.test(line)),
    },
    backgroundTerminalCount: composer ? readCodexBackgroundTerminalCount(lines, prompt) : 0,
    dialog: questionDrawer ?? (menu ? readFolderAccessPrompt(lines) ?? unreadablePrompt(lines) : null),
    output: working ? lines.slice(0, prompt).filter((line) => line.trim()).slice(-14) : [],
    input: composer ? lines.slice(prompt, capture.cursorY + 1).join('\n') : '',
    activity: menu ? 'waiting' as const : working ? 'working' as const : empty ? 'idle' as const : 'unknown' as const,
  };
}

/** Used by the Codex runtime and window registry to inspect a live TUI without changing it. */
export async function readCodexScreen(paneId: string) {
  return parseCodexScreen(await tmuxService.inspectPane(paneId));
}

function threadInStatus(lines: string[]) {
  const rows = lines.map((line) => line.trim().replace(/^│\s*|\s*│$/gu, '').trim());
  const composer = rows.map((line) => /^›(?:\s|$)/u.test(line)).lastIndexOf(true);
  if (composer < 0) return null;
  const card = rows.slice(0, composer).filter(Boolean);
  const boundary = card.map((line) => /^(?:›(?:\s|$)|[•■]\s|\/status$)/u.test(line)).lastIndexOf(true);
  // In the alternate screen the Session label can scroll off the top. Its UUID is the
  // value immediately above the usage fields, including when Codex wraps it across rows.
  for (let field = card.length - 1; field > boundary; field--) {
    if (!/^(?:Token usage|Context window|Limits|\S+ limit):/i.test(card[field])) continue;
    let id = '';
    for (let row = field - 1; row > boundary && id.length < 36; row--) {
      const value = card[row].replace(/^Session:\s*/i, '').replace(/\s/g, '');
      if (!/^[\da-f-]+$/i.test(value)) break;
      id = value + id;
    }
    if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return id;
  }
  return null;
}

/** Older AgentHarbor panes have no thread in their title. Ask their live TUI before delivering a chat message. */
export async function readCodexStatusThread(paneId: string, title: string, signal: AbortSignal, idleOnly = false) {
  if (!await typeCodexInput(paneId, '/status', [], title, signal, idleOnly ? () => true : undefined)) {
    throw new AgentWindowError('The Codex terminal is busy.');
  }
  const deadline = Date.now() + 3000;
  do {
    signal.throwIfAborted();
    const screen = await readCodexScreen(paneId);
    if (screen.title !== title) throw new AgentWindowError('The Codex terminal changed while checking its session.');
    if (screen.empty) {
      // The paste appeared in the composer before Enter. Once consumed, consecutive
      // /status commands can legitimately redraw an identical card.
      const threadId = threadInStatus(await tmuxService.capturePane(paneId, 80));
      if (threadId) return { screen, threadId };
    }
    await delay(75);
  } while (Date.now() < deadline);
  throw new AgentWindowError('Expand the Codex terminal until /status shows the full session ID, then send again.');
}

type Screen = ReturnType<typeof parseCodexScreen>;
type AcceptIdleScreen = (screen: Screen) => boolean | Promise<boolean>;

async function waitForScreen(paneId: string, accepts: (screen: Screen) => boolean, error: string, signal?: AbortSignal, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const screen = await readCodexScreen(paneId);
    if (accepts(screen)) return screen;
    await delay(50);
  } while (Date.now() < deadline);
  throw new AgentWindowError(error);
}

const pendingInput = new Map<string, Promise<boolean>>();

/** The idle reaper must keep the pane while a chat message or automatic prompt is being submitted. */
export function isWritingCodexInput(paneId: string): boolean {
  return pendingInput.has(paneId);
}

/** Serializes writes from chat and runtime services. An automatic prompt yields to an existing writer. */
export async function typeCodexInput(paneId: string, text: string, imagePaths: string[], expectedTitle: string, signal?: AbortSignal, acceptIdleScreen?: AcceptIdleScreen) {
  const previous = pendingInput.get(paneId);
  if (previous && acceptIdleScreen) return false;
  const write = () => submitCodexInput(paneId, text, imagePaths, expectedTitle, signal, acceptIdleScreen);
  const pending = previous ? previous.then(write, write) : write();
  pendingInput.set(paneId, pending);
  try {
    return await pending;
  } finally {
    if (pendingInput.get(paneId) === pending) pendingInput.delete(paneId);
  }
}

async function submitCodexInput(paneId: string, text: string, imagePaths: string[], expectedTitle: string,
  signal: AbortSignal | undefined, acceptIdleScreen?: AcceptIdleScreen) {
  let first = await readCodexScreen(paneId);
  if (!acceptIdleScreen && first.title === expectedTitle && !first.composer && !first.dialog) {
    first = await waitForScreen(paneId, screen => screen.title !== expectedTitle || screen.composer || Boolean(screen.dialog),
      'Codex is still redrawing its input. Check the terminal before sending.', signal);
  }
  if (acceptIdleScreen) {
    if (first.activity !== 'idle' || first.title !== expectedTitle || !await acceptIdleScreen(first)) return false;
    // A retry can check the transcript on disk before it claims the prompt.
    const latest = await readCodexScreen(paneId);
    if (latest.activity !== 'idle' || latest.title !== expectedTitle) return false;
  }
  if (first.title !== expectedTitle || !first.empty) {
    throw new AgentWindowError('Open Terminal and finish the Codex dialog or draft before sending.');
  }
  if (!text.trim() && !imagePaths.length) throw new AgentWindowError('The Codex message is empty.');
  // ConPTY may buffer the entire paste before the first visible change to the draft.
  const pasteTimeoutMs = 3000 + Math.min(text.length * 2, 120_000);
  let lastInput = first.input;
  for (const imagePath of imagePaths) {
    signal?.throwIfAborted();
    await pasteCodexText(paneId, imagePath, { imagePath: true });
    const attached = await waitForScreen(paneId, (screen) => screen.title === expectedTitle && screen.input !== lastInput
      && /\[Image #\d+\]\s*$/i.test(screen.input), 'Codex could not attach this image. Review the draft in Terminal.', signal);
    lastInput = attached.input;
  }
  if (text.trim()) {
    signal?.throwIfAborted();
    await pasteCodexText(paneId, text);
    const pasted = await waitForScreen(paneId, (screen) => screen.title === expectedTitle && screen.composer && !screen.empty && screen.input !== lastInput,
      'Codex did not accept the paste. Review the draft in Terminal.', signal, pasteTimeoutMs);
    lastInput = pasted.input;
  }
  let stableSince = performance.now();
  // Automatic prompts contain one line of text, which the TUI can wrap across several rows.
  const expectedPrompt = acceptIdleScreen ? text.replace(/\s+/g, '') : null;
  await waitForScreen(paneId, (screen) => {
    if (screen.title !== expectedTitle || screen.dialog) {
      throw new AgentWindowError('The Codex input changed before the message could be sent.');
    }
    // ConPTY briefly hides the cursor while repainting a partially rendered paste.
    if (!screen.composer || screen.empty) {
      stableSince = performance.now();
      return false;
    }
    if (expectedPrompt !== null) {
      const visiblePrompt = screen.input.slice(1).replace(/\s+/g, '');
      if (!expectedPrompt.startsWith(visiblePrompt)) {
        throw new AgentWindowError('The Codex draft changed during an automatic prompt.');
      }
      if (visiblePrompt !== expectedPrompt) return false;
    }
    if (screen.input !== lastInput) {
      lastInput = screen.input;
      stableSince = performance.now();
    }
    return performance.now() - stableSince >= pasteSettleMs;
  }, 'The pasted Codex message did not finish appearing in the terminal.', signal, pasteTimeoutMs);
  signal?.throwIfAborted();
  // ConPTY can show a stable prefix while the rest of the paste is still queued.
  // End closes Codex's paste burst without editing the draft, before Enter reaches it.
  await tmuxService.sendKeys(paneId, ['End', 'Enter']);
  // Windows can deliver long pastes character by character ahead of these keys.
  await waitForScreen(paneId, (screen) => {
    if (screen.title !== expectedTitle) throw new AgentWindowError('The terminal switched to a different Codex session.');
    return screen.empty || screen.dialog !== null;
  }, 'Codex did not submit the draft after Enter.', undefined, pasteTimeoutMs);
  return true;
}
