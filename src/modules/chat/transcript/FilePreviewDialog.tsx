import { DownloadIcon, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { fileNameOf, useFilePreviewBlob, type FilePreviewKind } from '@/modules/chat/utils/filePreview';
import { downloadFile } from '@/shared/downloadFile';

// Markdown imports this dialog (through the path actions), so the reverse edge is lazy.
const Markdown = lazy(async () => ({ default: (await import('@/modules/chat/transcript/Markdown')).Markdown }));

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

type TextPreview = { text: string; truncated: boolean } | { binary: true };

async function readTextPreview(blob: Blob): Promise<TextPreview> {
  const head = new Uint8Array(await blob.slice(0, BINARY_SNIFF_BYTES).arrayBuffer());
  if (head.includes(0)) {
    return { binary: true };
  }
  return { text: await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text(), truncated: blob.size > MAX_TEXT_PREVIEW_BYTES };
}

// The PDF renders in a same-origin iframe, so bytes that are not a PDF (an HTML
// or SVG file named .pdf) must never reach it.
async function looksLikePdf(blob: Blob): Promise<boolean> {
  return new TextDecoder('latin1').decode(await blob.slice(0, 1024).arrayBuffer()).includes('%PDF-');
}

function TextPreviewBody({ blob, kind }: { blob: Blob; kind: 'markdown' | 'text' }) {
  const { t } = useTranslation('chat');
  const [preview, setPreview] = useState<TextPreview | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void readTextPreview(blob).then((result) => isCurrent && setPreview(result));
    return () => {
      isCurrent = false;
    };
  }, [blob]);

  if (!preview) {
    return null;
  }
  if ('binary' in preview) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{t('filePreview.binary', 'This file is binary and has no preview.')}</p>;
  }
  return (
    <div className="h-full w-full overflow-auto p-4">
      {kind === 'markdown' ? (
        <Suspense fallback={null}>
          <Markdown className="prose prose-sm max-w-none dark:prose-invert">{preview.text}</Markdown>
        </Suspense>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{preview.text}</pre>
      )}
      {preview.truncated && (
        <p className="mt-3 text-xs text-muted-foreground">{t('filePreview.truncated', 'Only the first megabyte is shown.')}</p>
      )}
    </div>
  );
}

function PdfPreviewBody({ blob, url, name }: { blob: Blob; url: string; name: string }) {
  const { t } = useTranslation('chat');
  const [isPdf, setIsPdf] = useState<boolean | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void looksLikePdf(blob).then((result) => isCurrent && setIsPdf(result));
    return () => {
      isCurrent = false;
    };
  }, [blob]);

  if (isPdf === null) {
    return null;
  }
  if (!isPdf) {
    return <p className="p-6 text-center text-sm text-muted-foreground">{t('filePreview.failed', 'Could not open the preview.')}</p>;
  }
  // Not sandboxed: the browser's PDF viewer refuses to run in a sandboxed frame.
  return <iframe src={url} title={name} className="h-full w-full border-0 bg-white" />;
}

type FilePreviewDialogProps = {
  localPath: string;
  kind: Exclude<FilePreviewKind, 'image'>;
  onClose: () => void;
};

/** Shows a file the agent named (PDF, video, audio, text) over the chat, with a download button. */
export function FilePreviewDialog({ localPath, kind, onClose }: FilePreviewDialogProps) {
  const { t } = useTranslation('chat');
  const { url, blob, failed } = useFilePreviewBlob(localPath);
  const name = fileNameOf(localPath);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [onClose]);

  const renderBody = () => {
    if (failed) {
      return <p className="p-6 text-center text-sm text-muted-foreground">{t('filePreview.failed', 'Could not open the preview.')}</p>;
    }
    if (!url || !blob) {
      return <p className="p-6 text-center text-sm text-muted-foreground">{t('filePreview.loading', 'Loading…')}</p>;
    }
    switch (kind) {
      case 'pdf':
        return <PdfPreviewBody blob={blob} url={url} name={name} />;
      case 'video':
        return <video src={url} controls className="max-h-full max-w-full" />;
      case 'audio':
        return <audio src={url} controls className="w-full max-w-xl" />;
      default:
        return <TextPreviewBody blob={blob} kind={kind} />;
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-background shadow-2xl md:h-[85vh] md:max-w-5xl md:rounded-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={localPath}>{name}</span>
          <button
            type="button"
            onClick={() => void downloadFile(localPath)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('downloadPath.download', { path: name, defaultValue: 'Download {{path}}' })}
            title={t('downloadPath.download', { path: name, defaultValue: 'Download {{path}}' })}
          >
            <DownloadIcon className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('filePreview.close', 'Close preview')}
            title={t('filePreview.close', 'Close preview')}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30">{renderBody()}</div>
      </div>
    </div>,
    document.body,
  );
}
