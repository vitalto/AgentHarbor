/** Mirrors server/modules/tmux/tui-prompt.ts: a selection menu shown by the Claude TUI. */
export type TuiPromptOption = {
  label: string;
  detail: string | null;
  selected: boolean;
  /** AskUserQuestion's "Type something." slot: answered with typed text, not by picking it. */
  freeText: boolean;
  /** A multi-select question's checkbox (choosing the option toggles it); null or absent without one. */
  checked?: boolean | null;
  /** The "Submit"/"Next" row that confirms a multi-select question's ticked options. */
  confirmsSelection?: boolean;
};

export type TuiPrompt = {
  question: string;
  body: string[];
  options: TuiPromptOption[];
  /** AskUserQuestion's tab bar is shown: its questions can be switched back and forth. */
  questionTabs?: boolean;
  /** The model-safeguard "Session paused" dialog, which the server answers on a timer unless the user picks first. */
  safeguardPause?: boolean;
  /** The preview box an AskUserQuestion draws for the option under its marker. */
  preview?: string[];
  /** Claude waits on a dialog the server cannot read: `body` is the raw screen, answered with keys. */
  unreadable?: boolean;
};

/** Which way to switch an AskUserQuestion set's questions. */
export type QuestionStep = 'previous' | 'next';

// Spinner glyphs only: "●" marks tool calls and replies, whose truncated text also ends in "…".
// The verb is a short phrase followed by its timer, e.g. "✻ Running tests… (12s · ↓ 2.1k tokens)".
const SPINNER_LINE = /^\s*[✻✽✶✳✢·*]\s+([^\s(…][^(…]{0,40}…)(?:\s+\(|\s*$)/;

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
export type TuiKey = 'Escape' | 'Enter' | 'Up' | 'Down' | 'Left' | 'Right' | 'Tab' | 'BTab' | 'C-c';
