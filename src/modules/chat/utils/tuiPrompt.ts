/** Mirrors server/modules/tmux/tui-prompt.ts: a selection menu shown by the Claude TUI. */
export type TuiPromptOption = {
  label: string;
  detail: string | null;
  selected: boolean;
};

export type TuiPrompt = {
  question: string;
  body: string[];
  options: TuiPromptOption[];
};

const SPINNER_LINE = /^\s*[^\w\s>❯]\s+([^…]+…)/;

/**
 * The verb of the TUI's spinner line ("* Kneading… (3s · thinking)" →
 * "Kneading…"), or null when the screen shows none. The activity pill counts
 * elapsed time itself, so only the word is taken.
 */
export function extractTuiActivity(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = SPINNER_LINE.exec(lines[index]);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

/** tmux key names the key bar can send to the agent's window. */
export type TuiKey = 'Escape' | 'Enter' | 'Up' | 'Down' | 'BTab' | 'C-c';
