import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { PaperclipIcon, MessageSquareIcon, XIcon, ArrowUpIcon } from 'lucide-react';

import type { QueuedDraft, SlashCommand, SessionActivity } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import TuiKeyBar from '@/modules/chat/composer/TuiKeyBar';
import TuiPromptPanel from '@/modules/chat/composer/TuiPromptPanel';
import type { TuiKey, TuiPrompt } from '@/modules/chat/utils/tuiPrompt';

type MentionableFile = {
  name: string;
  path: string;
};

type ChatComposerProps = {
  /** A menu the session's Claude TUI is showing right now, if any. */
  tuiPrompt: TuiPrompt | null;
  onTuiChoose: (optionIndex: number) => void;
  onTuiKey: (key: TuiKey) => void;
  /** The session has a live Claude window to send keys to. */
  hasLiveWindow: boolean;
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  /** Messages waiting to be sent to this session later. */
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, queued message, the live TUI menu (as buttons) and the key
 * bar for the session's Claude window.
 */
export default function ChatComposer({
  tuiPrompt,
  onTuiChoose,
  onTuiKey,
  hasLiveWindow,
  activity,
  isLoading,
  onAbortSession,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Hide the thinking/status bar while the TUI waits on a menu answer
  const hasPendingPrompt = Boolean(tuiPrompt);
  const hasActivityIndicator = Boolean(activity && !hasPendingPrompt);

  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : sendByCtrlEnter
      ? t('input.hintText.ctrlEnter')
      : t('input.hintText.enter');
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : isLoading
      ? t('input.stop')
      : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {!hasPendingPrompt && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {tuiPrompt && (
        <div className="mx-auto max-w-[54.25rem]">
          <TuiPromptPanel prompt={tuiPrompt} onChoose={onTuiChoose} onCancel={() => onTuiKey('Escape')} />
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            hasActivityIndicator ? 'rounded-t-none' : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter className="flex-wrap gap-y-1">
          <PromptInputTools className="min-w-0">
            <PromptInputButton
              tooltip={{ content: t('input.attachFiles') }}
              onClick={openAttachmentPicker}
              aria-label={t('input.attachFiles')}
            >
              <PaperclipIcon />
            </PromptInputButton>

            <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />

            <PromptInputButton
              tooltip={{ content: t('input.showAllCommands') }}
              onClick={onToggleCommandMenu}
              className="relative"
            >
              <MessageSquareIcon />
              {slashCommandsCount > 0 && (
                <span
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                >
                  {slashCommandsCount}
                </span>
              )}
            </PromptInputButton>

            {hasInput && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="hidden sm:flex"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            {hasLiveWindow && <TuiKeyBar onKey={onTuiKey} />}

            <PromptInputSubmit
              onClick={
                canQueueDraft
                  ? (e: MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  : isLoading
                    ? onAbortSession
                    : undefined
              }
              disabled={isLoading ? false : !input.trim() && attachedFiles.length === 0}
              aria-label={submitAriaLabel}
              title={submitAriaLabel}
              className="h-10 w-10 sm:h-10 sm:w-10"
            >
              {canQueueDraft ? <ArrowUpIcon className="h-4 w-4" /> : undefined}
            </PromptInputSubmit>
          </div>

          <div
            className={`order-last hidden basis-full px-2 text-center text-xs leading-4 text-muted-foreground/50 transition-opacity duration-200 lg:block ${
              input.trim() && !canQueueDraft ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {submitHint}
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>
    </div>
  );
}
