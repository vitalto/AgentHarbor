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

/** tmux key names the key bar can send to the agent's window. */
export type TuiKey = 'Escape' | 'Enter' | 'Up' | 'Down' | 'BTab' | 'C-c';
