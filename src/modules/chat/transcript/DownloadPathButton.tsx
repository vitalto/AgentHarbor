import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { downloadFile } from '@/shared/downloadFile';

type DownloadState = { status: 'idle' | 'downloading' } | { status: 'failed'; message: string };

export function DownloadPathButton({ path }: { path: string }) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<DownloadState>({ status: 'idle' });

  const download = async () => {
    setState({ status: 'downloading' });
    try {
      await downloadFile(path);
      setState({ status: 'idle' });
    } catch (error) {
      setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const label = state.status === 'failed'
    ? t('downloadPath.failed', { message: state.message, defaultValue: 'Download failed: {{message}}' })
    : t('downloadPath.download', { path, defaultValue: 'Download {{path}}' });

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.status !== 'downloading') {
          void download();
        }
      }}
      title={label}
      aria-label={label}
      className={`mx-0.5 inline-flex h-[1.25em] w-[1.25em] items-center justify-center rounded align-middle transition-colors hover:bg-muted ${
        state.status === 'failed' ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <DownloadIcon className={`h-[0.9em] w-[0.9em] ${state.status === 'downloading' ? 'opacity-40' : ''}`} aria-hidden />
    </button>
  );
}
