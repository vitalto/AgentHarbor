import { useEffect, useState } from 'react';
import { ArrowUpIcon, CheckSquareIcon, ChevronLeftIcon, ChevronRightIcon, MessageSquareMoreIcon, SquareIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Confirmation, ConfirmationTitle } from '@/modules/chat/composer/Confirmation';
import type { QuestionStep, TuiKey, TuiPrompt, TuiPromptOption } from '@/modules/chat/utils/tuiPrompt';

type TuiPromptPanelProps = {
  prompt: TuiPrompt;
  /** When a safeguard pause will be auto-answered (epoch ms); shows a countdown toward the first option. */
  autoAnswerAt?: number | null;
  onChoose: (optionIndex: number, freeText?: string) => void;
  onCancel: () => void;
  onQuestionStep?: (step: QuestionStep) => void;
  /** Presses one key in the agent's window; answers a dialog the server could not read. */
  onKey?: (key: TuiKey) => void;
};

const RAW_KEYS: Array<{ key: TuiKey; label: string }> = [
  { key: 'Up', label: '↑' },
  { key: 'Down', label: '↓' },
  { key: 'Left', label: '←' },
  { key: 'Right', label: '→' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Enter', label: 'Enter' },
  { key: 'Escape', label: 'Esc' },
];

/** A dialog the server could not turn into options: the screen as is, and the keys that answer it. */
function UnreadablePrompt({ prompt, onKey }: { prompt: TuiPrompt; onKey?: (key: TuiKey) => void }) {
  return (
    <Confirmation approval="pending" className="mb-3" data-testid="tui-prompt">
      <ConfirmationTitle className="flex items-start gap-3">
        <MessageSquareMoreIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">Claude is waiting for an answer in a menu AgentHarbor cannot read</span>
      </ConfirmationTitle>
      <pre className="max-h-72 w-full overflow-auto whitespace-pre rounded-md border bg-muted/50 p-2 font-mono text-xs text-foreground">
        {prompt.body.join('\n')}
      </pre>
      {onKey && (
        <div className="flex flex-wrap gap-1.5">
          {RAW_KEYS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => onKey(key)}
              className="min-w-10 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </Confirmation>
  );
}

/** Seconds left until `deadline`, re-rendering once a second; null when there is no deadline. */
function useCountdown(deadline: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

type FreeTextOptionProps = {
  option: TuiPromptOption;
  number: number;
  onSubmit: (freeText: string) => void;
};

function Tick({ checked }: { checked: boolean }) {
  const Icon = checked ? CheckSquareIcon : SquareIcon;
  return <Icon className={cn('h-4 w-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} aria-hidden />;
}

/** Picking this slot with nothing typed would make Claude decline the whole question, so it only sends text. */
function FreeTextOption({ option, number, onSubmit }: FreeTextOptionProps) {
  const [answer, setAnswer] = useState('');
  const submit = () => {
    if (answer.trim()) {
      onSubmit(answer);
      setAnswer('');
    }
  };

  return (
    <div
      className={cn(
        'flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
        option.selected ? 'border-primary bg-primary/5' : 'border-border',
      )}
    >
      <span className="text-muted-foreground">{number}.</span>
      {typeof option.checked === 'boolean' && <Tick checked={option.checked} />}
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
 * Enter in the real terminal; in a multi-select question that toggles the
 * option, and the confirm row ("Next"/"Submit") moves on.
 */
export default function TuiPromptPanel({ prompt, autoAnswerAt, onChoose, onCancel, onQuestionStep, onKey }: TuiPromptPanelProps) {
  const context = prompt.body.filter((line) => line !== prompt.question);
  const isMultiSelect = prompt.options.some((option) => typeof option.checked === 'boolean');
  const secondsLeft = useCountdown(prompt.safeguardPause ? autoAnswerAt : null);
  const autoAnswerLabel = prompt.options[0]?.label;
  // The TUI does not number the confirm row, so the options after it keep their own numbers.
  const optionNumbers = prompt.options.map((_, index) =>
    prompt.options.slice(0, index + 1).filter((option) => !option.confirmsSelection).length);

  if (prompt.unreadable) {
    return <UnreadablePrompt prompt={prompt} onKey={onKey} />;
  }

  return (
    <Confirmation approval="pending" className="mb-3" data-testid="tui-prompt">
      <ConfirmationTitle className="flex items-start gap-3">
        <MessageSquareMoreIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{prompt.question}</span>
      </ConfirmationTitle>

      {secondsLeft !== null && autoAnswerLabel && (
        <p className="text-xs text-muted-foreground" data-testid="tui-auto-answer">
          Auto-selecting <span className="font-medium text-foreground">{autoAnswerLabel}</span> in {secondsLeft}s — choose another option to keep control.
        </p>
      )}

      {context.length > 0 && (
        <details className="text-xs" open={context.length <= 4}>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
            {context.join('\n')}
          </pre>
        </details>
      )}

      {prompt.preview && prompt.preview.length > 0 && (
        <pre className="max-h-64 w-full overflow-auto whitespace-pre rounded-md border bg-muted/50 p-2 font-mono text-xs text-foreground" data-testid="tui-preview">
          {prompt.preview.join('\n')}
        </pre>
      )}

      {isMultiSelect && (
        <p className="text-xs text-muted-foreground">Tick every answer that applies, then press the button below them.</p>
      )}

      <div className="flex w-full flex-col gap-1.5">
        {prompt.options.map((option, index) => {
          if (option.freeText) {
            return (
              <FreeTextOption
                // A question set reuses the slot for every question; a new question must start with an empty field.
                key={`${prompt.body.join('\n')}-${index}`}
                option={option}
                number={optionNumbers[index]}
                onSubmit={(freeText) => onChoose(index, freeText)}
              />
            );
          }
          if (option.confirmsSelection) {
            return (
              <button
                key={`${index}-${option.label}`}
                type="button"
                onClick={() => onChoose(index)}
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {option.label}
              </button>
            );
          }
          const isCheckbox = typeof option.checked === 'boolean';
          return (
            <button
              key={`${index}-${option.label}`}
              type="button"
              role={isCheckbox ? 'checkbox' : undefined}
              aria-checked={isCheckbox ? Boolean(option.checked) : undefined}
              onClick={() => onChoose(index)}
              className={cn(
                'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                option.selected ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">{optionNumbers[index]}.</span>
                {isCheckbox && <Tick checked={Boolean(option.checked)} />}
                <span className="text-foreground">{option.label}</span>
              </span>
              {option.detail && <span className="mt-0.5 block break-all text-xs text-muted-foreground">{option.detail}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1">
        {prompt.questionTabs && onQuestionStep && (
          <>
            <button
              type="button"
              onClick={() => onQuestionStep('previous')}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" aria-hidden />
              Previous question
            </button>
            <button
              type="button"
              onClick={() => onQuestionStep('next')}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Next question
              <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        )}
        <button type="button" onClick={onCancel} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
          Cancel (Esc)
        </button>
      </div>
    </Confirmation>
  );
}
