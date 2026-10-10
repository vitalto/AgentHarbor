export type TuiPromptOption = {
  label: string;
  detail: string | null;
  selected: boolean;
  /** AskUserQuestion's "Type something." slot: an inline text field, not a choice. */
  freeText: boolean;
};

export type TuiPrompt = {
  /** The line asking the user something, or the whole dialog text when no line is a question. */
  question: string;
  /** Dialog text above the options (title, command, diff preview), top to bottom. */
  body: string[];
  options: TuiPromptOption[];
};

const MENU_FOOTER = /Esc to cancel|Enter to confirm|Enter to select/;
const DIALOG_BORDER = /^\s*─{10,}\s*$/;
const ANY_RULE = /^\s*[─━╌]{10,}\s*$/;
const NUMBERED_OPTION = /^(\s*)(?:([>❯›])\s*)?(\d+)\.\s+(.*)$/;
const CURSOR_LINE = /^(\s*)([>❯›])(\s+)(\S.*)$/;
const FOOTER_SEARCH_DEPTH = 4;
const FREE_TEXT_PLACEHOLDER = 'Type something.';
/** Shown in the footer only while the cursor sits on the free-text slot; its label is then whatever was typed. */
const FREE_TEXT_FOOTER_HINT = /ctrl\+g to edit/;

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function lastNonEmptyIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      return index;
    }
  }
  return -1;
}

function findFooter(lines: string[]): number {
  const last = lastNonEmptyIndex(lines);
  for (let index = last; index >= 0 && index >= last - FOOTER_SEARCH_DEPTH; index -= 1) {
    if (MENU_FOOTER.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

/** AskUserQuestion's tab bar with several questions: `←  [×] Q1  [ ] Q2  √ Submit  →`. */
const QUESTION_SET_TABS = /^\s*←\s.*\bSubmit\s+→$/;

/**
 * Index of the menu's key-hint footer, or — for the question set's review step
 * ("Ready to submit your answers?"), which draws no footer — the line just
 * below its last option. -1 when no menu is open.
 */
function findMenuEnd(lines: string[]): number {
  const footer = findFooter(lines);
  if (footer >= 0) {
    return footer;
  }
  const last = lastNonEmptyIndex(lines);
  if (last < 0 || !NUMBERED_OPTION.test(lines[last])) {
    return -1;
  }
  let dialogTop = last - 1;
  while (dialogTop >= 0 && !DIALOG_BORDER.test(lines[dialogTop])) {
    dialogTop -= 1;
  }
  return dialogTop >= 0 && QUESTION_SET_TABS.test(lines[dialogTop + 1] ?? '') ? last + 1 : -1;
}

/** Joins a wrapped continuation onto text; a line that filled the screen was hard-wrapped mid-word. */
function appendWrapped(text: string, previousLine: string, continuation: string, screenWidth: number): string {
  const separator = previousLine.length >= screenWidth - 1 ? '' : ' ';
  return `${text}${separator}${continuation.trim()}`;
}

type OptionBlock = { options: TuiPromptOption[]; topIndex: number };

function readNumberedOptions(lines: string[], footerIndex: number, screenWidth: number): OptionBlock | null {
  type RawOption = { number: number; lines: string[]; selected: boolean; firstLine: string; index: number };
  const found: RawOption[] = [];
  let continuation: string[] = [];

  for (let index = footerIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim() || ANY_RULE.test(line)) {
      continue;
    }
    const match = NUMBERED_OPTION.exec(line);
    if (match) {
      found.unshift({ number: Number(match[3]), lines: continuation, selected: Boolean(match[2]), firstLine: line, index });
      continuation = [];
      if (match[3] === '1') {
        break;
      }
      continue;
    }
    if (found.length === 0 && leadingSpaces(line) < 3) {
      return null;
    }
    if (leadingSpaces(line) >= 3) {
      continuation.unshift(line);
      continue;
    }
    break;
  }

  if (found.length < 2 || found[0].number !== 1) {
    return null;
  }

  const options = found.map((raw) => {
    const label = NUMBERED_OPTION.exec(raw.firstLine)?.[4]?.trim() ?? '';
    let detail: string | null = null;
    let previousLine = raw.firstLine;
    let labelText = label;
    for (const continuationLine of raw.lines) {
      if (detail === null && previousLine.length >= screenWidth - 12) {
        labelText = appendWrapped(labelText, previousLine, continuationLine, screenWidth);
      } else {
        detail = detail === null ? continuationLine.trim() : appendWrapped(detail, previousLine, continuationLine, screenWidth);
      }
      previousLine = continuationLine;
    }
    return { label: labelText, detail, selected: raw.selected, freeText: false };
  });
  return { options, topIndex: found[0].index };
}

function readCursorOptions(lines: string[], footerIndex: number): OptionBlock | null {
  let cursorIndex = -1;
  let textColumn = -1;
  for (let index = footerIndex - 1; index >= 0 && index >= footerIndex - 12; index -= 1) {
    const match = CURSOR_LINE.exec(lines[index]);
    if (match) {
      cursorIndex = index;
      textColumn = match[1].length + match[2].length + match[3].length;
      break;
    }
  }
  if (cursorIndex < 0) {
    return null;
  }

  const isOptionLine = (index: number) =>
    index === cursorIndex
    || (lines[index].trim() !== '' && leadingSpaces(lines[index]) === textColumn)
    || CURSOR_LINE.test(lines[index]);

  let top = cursorIndex;
  while (top - 1 >= 0 && isOptionLine(top - 1)) {
    top -= 1;
  }
  let bottom = cursorIndex;
  while (bottom + 1 < footerIndex && isOptionLine(bottom + 1)) {
    bottom += 1;
  }
  if (bottom === top) {
    return null;
  }

  const options: TuiPromptOption[] = [];
  for (let index = top; index <= bottom; index += 1) {
    const cursor = CURSOR_LINE.exec(lines[index]);
    options.push({ label: (cursor ? cursor[4] : lines[index]).trim(), detail: null, selected: index === cursorIndex, freeText: false });
  }
  return { options, topIndex: top };
}

function readBody(lines: string[], optionsTopIndex: number): string[] {
  const body: string[] = [];
  for (let index = optionsTopIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (DIALOG_BORDER.test(line)) {
      break;
    }
    if (line.trim() && !ANY_RULE.test(line)) {
      body.unshift(line.trim());
    }
  }
  return body;
}

/** Recognises a Claude Code selection menu (permission, question, trust dialog) at the bottom of a pane. */
export function parseTuiPrompt(lines: string[]): TuiPrompt | null {
  const footerIndex = findMenuEnd(lines);
  if (footerIndex < 0) {
    return null;
  }
  const screenWidth = Math.max(...lines.map((line) => line.length));
  const block = readNumberedOptions(lines, footerIndex, screenWidth) ?? readCursorOptions(lines, footerIndex);
  if (!block) {
    return null;
  }

  const cursorOnFreeText = FREE_TEXT_FOOTER_HINT.test(lines[footerIndex] ?? '');
  const options = block.options.map((option) => ({
    ...option,
    freeText: option.label === FREE_TEXT_PLACEHOLDER || (cursorOnFreeText && option.selected),
  }));

  const body = readBody(lines, block.topIndex);
  const question = [...body].reverse().find((line) => line.endsWith('?')) ?? body.join(' ');
  return { question, body, options };
}

/** tmux key names that move the menu cursor from the selected option to `targetIndex`, without confirming. */
export function keysToReachOption(prompt: TuiPrompt, targetIndex: number): string[] {
  const selectedIndex = Math.max(0, prompt.options.findIndex((option) => option.selected));
  const distance = targetIndex - selectedIndex;
  return Array.from({ length: Math.abs(distance) }, () => (distance > 0 ? 'Down' : 'Up'));
}

/** tmux key names that move the menu cursor from the selected option to `targetIndex` and confirm. */
export function keysForOption(prompt: TuiPrompt, targetIndex: number): string[] {
  return [...keysToReachOption(prompt, targetIndex), 'Enter'];
}

const INPUT_PROMPT = /^[>❯]\s?/;
const PASTING = /^\s*Pasting…/;

export type InputBox = {
  text: string;
  /** The TUI is still absorbing a paste: the box looks empty but the text is about to appear. */
  pasting: boolean;
};

/** The prompt input box (`> ` between two horizontal rules) when it is on screen and no menu covers it. */
export function readInputBox(lines: string[]): InputBox | null {
  if (findMenuEnd(lines) >= 0) {
    return null;
  }
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    if (!INPUT_PROMPT.test(lines[index]) || !DIALOG_BORDER.test(lines[index - 1])) {
      continue;
    }
    const closingRule = lines.findIndex((line, lineIndex) => lineIndex > index && DIALOG_BORDER.test(line));
    if (closingRule < 0) {
      return null;
    }
    const text = [lines[index].replace(INPUT_PROMPT, ''), ...lines.slice(index + 1, closingRule)]
      .map((line) => line.trim())
      .join('\n')
      .trim();
    return { text, pasting: lines.slice(closingRule + 1).some((line) => PASTING.test(line)) };
  }
  return null;
}

export function isInputReady(lines: string[]): boolean {
  return readInputBox(lines) !== null;
}
