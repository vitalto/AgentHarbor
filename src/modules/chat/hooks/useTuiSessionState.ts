import { useCallback, useState } from 'react';

import type { TuiPrompt } from '@/modules/chat/utils/tuiPrompt';

export type TuiSessionState = {
  prompt: TuiPrompt | null;
  /** When an open safeguard pause will be auto-answered (epoch ms), or null when there is no countdown. */
  autoAnswerAt: number | null;
  /** What the TUI prints right now, above its input box; empty when idle. */
  screen: string[];
};

export type TuiEvent =
  | { kind: 'tui_prompt'; prompt: TuiPrompt; autoAnswerAt?: number }
  | { kind: 'tui_prompt_cleared' }
  | { kind: 'tui_screen'; lines: string[] };

const EMPTY_STATE: TuiSessionState = { prompt: null, autoAnswerAt: null, screen: [] };

export function applyTuiEvent(state: TuiSessionState, event: TuiEvent): TuiSessionState {
  switch (event.kind) {
    case 'tui_prompt':
      return { ...state, prompt: event.prompt, autoAnswerAt: event.autoAnswerAt ?? null };
    case 'tui_prompt_cleared':
      return { ...state, prompt: null, autoAnswerAt: null };
    case 'tui_screen':
      return { ...state, screen: event.lines };
  }
}

/** Live TUI state (open menu, current screen tail) per app session id. */
export function useTuiSessionState() {
  const [bySession, setBySession] = useState<Record<string, TuiSessionState>>({});

  const handleTuiEvent = useCallback((sessionId: string, event: TuiEvent) => {
    setBySession((previous) => ({
      ...previous,
      [sessionId]: applyTuiEvent(previous[sessionId] ?? EMPTY_STATE, event),
    }));
  }, []);

  const getTuiState = useCallback(
    (sessionId: string | null | undefined): TuiSessionState => (sessionId ? bySession[sessionId] : undefined) ?? EMPTY_STATE,
    [bySession],
  );

  return { handleTuiEvent, getTuiState };
}
