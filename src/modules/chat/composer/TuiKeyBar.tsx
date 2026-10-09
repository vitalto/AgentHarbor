import type { TuiKey } from '@/modules/chat/utils/tuiPrompt';

const KEYS: Array<{ key: TuiKey; label: string; title: string }> = [
  { key: 'Escape', label: 'Esc', title: 'Interrupt / cancel' },
  { key: 'Up', label: '↑', title: 'Up' },
  { key: 'Down', label: '↓', title: 'Down' },
  { key: 'Enter', label: '⏎', title: 'Enter' },
  { key: 'BTab', label: '⇧Tab', title: 'Cycle permission mode' },
  { key: 'C-c', label: '^C', title: 'Ctrl+C' },
];

type TuiKeyBarProps = {
  onKey: (key: TuiKey) => void;
  disabled?: boolean;
};

/** Raw keys for whatever the TUI shows that the chat view does not model. */
export default function TuiKeyBar({ onKey, disabled }: TuiKeyBarProps) {
  return (
    <div className="flex flex-wrap gap-1" data-testid="tui-key-bar">
      {KEYS.map(({ key, label, title }) => (
        <button
          key={key}
          type="button"
          title={title}
          disabled={disabled}
          onClick={() => onKey(key)}
          className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
