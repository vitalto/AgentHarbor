export type TuiPromptOption = {
  label: string;
  detail: string | null;
  selected: boolean;
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
    return { label: labelText, detail, selected: raw.selected };
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
    options.push({ label: (cursor ? cursor[4] : lines[index]).trim(), detail: null, selected: index === cursorIndex });
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
  const footerIndex = findFooter(lines);
  if (footerIndex < 0) {
    return null;
  }
  const screenWidth = Math.max(...lines.map((line) => line.length));
  const block = readNumberedOptions(lines, footerIndex, screenWidth) ?? readCursorOptions(lines, footerIndex);
  if (!block) {
    return null;
  }

  const body = readBody(lines, block.topIndex);
  const question = [...body].reverse().find((line) => line.endsWith('?')) ?? body.join(' ');
  return { question, body, options: block.options };
}

/** tmux key names that move the menu cursor from the selected option to `targetIndex` and confirm. */
export function keysForOption(prompt: TuiPrompt, targetIndex: number): string[] {
  const selectedIndex = Math.max(0, prompt.options.findIndex((option) => option.selected));
  const distance = targetIndex - selectedIndex;
  const moves = Array.from({ length: Math.abs(distance) }, () => (distance > 0 ? 'Down' : 'Up'));
  return [...moves, 'Enter'];
}

/** The prompt input box (`> ` between two horizontal rules) is on screen and no menu covers it. */
export function isInputReady(lines: string[]): boolean {
  if (findFooter(lines) >= 0) {
    return false;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (/^[>❯]\s?/.test(lines[index]) && DIALOG_BORDER.test(lines[index - 1])) {
      return lines.slice(index + 1, index + 6).some((line) => DIALOG_BORDER.test(line));
    }
  }
  return false;
}
