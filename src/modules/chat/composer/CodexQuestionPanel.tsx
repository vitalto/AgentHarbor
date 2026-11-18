import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TuiPrompt } from '@/modules/chat/utils/tuiPrompt';

/** ChatComposer shows the open Codex question here even when its transcript entry is on an older page. */
export function CodexQuestionPanel({ prompt, onChoose, onBack, onOpenTerminal }: {
  prompt: TuiPrompt;
  onChoose: (index: number) => void;
  onBack: () => void;
  onOpenTerminal?: () => void;
}) {
  const { t } = useTranslation('chat');
  // A choice stays local until the user sends it. The composer remounts this panel when the native question changes.
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <fieldset className="mx-auto mb-2 max-h-[42dvh] min-w-0 max-w-[54.25rem] overflow-y-auto rounded-xl border border-border bg-card p-3 text-sm">
      <legend className="px-1 font-medium">{t('interaction.nativeQuestion')}</legend>
      <p dir="auto" className="whitespace-pre-wrap break-words">{prompt.question || prompt.body.join('\n')}</p>
      <div className="mt-2 space-y-1">
        {prompt.options.map((option, index) => !option.freeText && (
          <label key={index} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 hover:bg-accent">
            <input type="radio" name={prompt.codexQuestionId} className="mt-1" checked={selected === index} onChange={() => setSelected(index)} />
            <span dir="auto" className="min-w-0 break-words">{option.label}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {prompt.options.some(option => !option.freeText) && (
          <button type="button" disabled={selected === null} onClick={() => { if (selected !== null) onChoose(selected); }}
            className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">
            {t('interaction.submitNative')}
          </button>
        )}
        {onOpenTerminal && (
          <button type="button" className="rounded-md px-2 py-2 text-primary hover:underline" onClick={onOpenTerminal}>
            {t('interaction.terminalReply')}
          </button>
        )}
        <button type="button" className="ml-auto rounded-md px-2 py-2 text-muted-foreground hover:underline" onClick={onBack}>
          {t('interaction.closeNative')}
        </button>
      </div>
    </fieldset>
  );
}
