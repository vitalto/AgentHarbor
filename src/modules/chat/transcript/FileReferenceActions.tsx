import { EyeIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTranscriptSessionId } from '@/modules/chat/context/TranscriptSessionContext';
import { DownloadPathButton } from '@/modules/chat/transcript/DownloadPathButton';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';
import { FilePreviewDialog } from '@/modules/chat/transcript/FilePreviewDialog';
import { fileNameOf, getFilePreviewKind, useFilePreviewBlob } from '@/modules/chat/utils/filePreview';
import { useResolvedFileReference } from '@/modules/chat/utils/resolveFileReferences';

function ImageThumbnail({ localPath }: { localPath: string }) {
  const { t } = useTranslation();
  const { url, failed } = useFilePreviewBlob(localPath);
  const [expanded, setExpanded] = useState(false);
  const name = fileNameOf(localPath);

  if (failed) {
    return null;
  }
  if (!url) {
    return <span className="my-1.5 block h-32 w-48 max-w-full animate-pulse rounded-lg border border-border/50 bg-muted" />;
  }
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(true);
        }}
        aria-label={t('chat:misc.expandImage', { name })}
        className="my-1.5 block max-w-full overflow-hidden rounded-lg border border-border/50 bg-muted/30 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img src={url} alt={name} loading="lazy" className="block max-h-64 max-w-full cursor-zoom-in object-contain" />
      </button>
      {expanded && <ImageLightbox src={url} alt={name} onClose={() => setExpanded(false)} />}
    </>
  );
}

/**
 * What follows a path an agent wrote in the chat, once the server confirms the
 * file exists: a download button, and a preview for types the browser can
 * show (images inline, PDF/video/audio/text in a dialog).
 */
export function FileReferenceActions({ reference }: { reference: string }) {
  const { t } = useTranslation('chat');
  const sessionId = useTranscriptSessionId();
  const localPath = useResolvedFileReference(sessionId, reference);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  if (!localPath) {
    return null;
  }

  const previewKind = getFilePreviewKind(localPath);
  const name = fileNameOf(localPath);
  const previewLabel = t('filePreview.open', { name, defaultValue: 'Preview {{name}}' });

  return (
    <>
      {previewKind && previewKind !== 'image' && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setIsPreviewOpen(true);
          }}
          title={previewLabel}
          aria-label={previewLabel}
          className="ml-0.5 inline-flex h-[1.25em] w-[1.25em] items-center justify-center rounded align-middle text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <EyeIcon className="h-[0.9em] w-[0.9em]" aria-hidden />
        </button>
      )}
      <DownloadPathButton path={localPath} />
      {previewKind === 'image' && <ImageThumbnail localPath={localPath} />}
      {isPreviewOpen && previewKind && previewKind !== 'image' && (
        <FilePreviewDialog localPath={localPath} kind={previewKind} onClose={() => setIsPreviewOpen(false)} />
      )}
    </>
  );
}
