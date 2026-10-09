import { MessageSquareMoreIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Confirmation, ConfirmationTitle } from '@/modules/chat/composer/Confirmation';
import type { TuiPrompt } from '@/modules/chat/utils/tuiPrompt';

type TuiPromptPanelProps = {
  prompt: TuiPrompt;
  onChoose: (optionIndex: number) => void;
  onCancel: () => void;
};

/**
 * A menu the Claude TUI is showing right now (permission, question, trust
 * dialog), rendered as buttons. Choosing one moves the TUI cursor and presses
 * Enter in the real terminal.
 */
export default function TuiPromptPanel({ prompt, onChoose, onCancel }: TuiPromptPanelProps) {
  const context = prompt.body.filter((line) => line !== prompt.question);

  return (
    <Confirmation approval="pending" className="mb-3" data-testid="tui-prompt">
      <ConfirmationTitle className="flex items-start gap-3">
        <MessageSquareMoreIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{prompt.question}</span>
      </ConfirmationTitle>

      {context.length > 0 && (
        <details className="text-xs" open={context.length <= 4}>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
            {context.join('\n')}
          </pre>
        </details>
      )}

      <div className="flex flex-col gap-1.5">
        {prompt.options.map((option, index) => (
          <button
            key={`${index}-${option.label}`}
            type="button"
            onClick={() => onChoose(index)}
            className={cn(
              'rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
              option.selected ? 'border-primary bg-primary/5' : 'border-border',
            )}
          >
            <span className="mr-2 text-muted-foreground">{index + 1}.</span>
            <span className="text-foreground">{option.label}</span>
            {option.detail && <span className="mt-0.5 block break-all text-xs text-muted-foreground">{option.detail}</span>}
          </button>
        ))}
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">
          Cancel (Esc)
        </button>
      </div>
    </Confirmation>
  );
}
