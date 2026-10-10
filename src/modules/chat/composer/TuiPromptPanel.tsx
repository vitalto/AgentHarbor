import { useState } from 'react';
import { ArrowUpIcon, MessageSquareMoreIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Confirmation, ConfirmationTitle } from '@/modules/chat/composer/Confirmation';
import type { TuiPrompt, TuiPromptOption } from '@/modules/chat/utils/tuiPrompt';

type TuiPromptPanelProps = {
  prompt: TuiPrompt;
  onChoose: (optionIndex: number, freeText?: string) => void;
  onCancel: () => void;
};

type FreeTextOptionProps = {
  option: TuiPromptOption;
  index: number;
  onSubmit: (freeText: string) => void;
};

/** Picking this slot with nothing typed would make Claude decline the whole question, so it only sends text. */
function FreeTextOption({ option, index, onSubmit }: FreeTextOptionProps) {
  const [answer, setAnswer] = useState('');
  const submit = () => {
    if (answer.trim()) {
      onSubmit(answer);
    }
  };

  return (
    <div
      className={cn(
        'flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
        option.selected ? 'border-primary bg-primary/5' : 'border-border',
      )}
    >
      <span className="text-muted-foreground">{index + 1}.</span>
      <input
        type="text"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={option.label}
        className="min-w-0 flex-1 bg-transparent py-0.5 text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        aria-label="Send answer"
        onClick={submit}
        disabled={!answer.trim()}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <ArrowUpIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

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

      <div className="flex w-full flex-col gap-1.5">
        {prompt.options.map((option, index) => (option.freeText ? (
          <FreeTextOption
            // A question set reuses the slot for every question; a new question must start with an empty field.
            key={`${prompt.body.join('\n')}-${index}`}
            option={option}
            index={index}
            onSubmit={(freeText) => onChoose(index, freeText)}
          />
        ) : (
          <button
            key={`${index}-${option.label}`}
            type="button"
            onClick={() => onChoose(index)}
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
              option.selected ? 'border-primary bg-primary/5' : 'border-border',
            )}
          >
            <span className="mr-2 text-muted-foreground">{index + 1}.</span>
            <span className="text-foreground">{option.label}</span>
            {option.detail && <span className="mt-0.5 block break-all text-xs text-muted-foreground">{option.detail}</span>}
          </button>
        )))}
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">
          Cancel (Esc)
        </button>
      </div>
    </Confirmation>
  );
}
