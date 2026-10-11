import { useEffect, useState } from 'react';

import { getPreviewKind, getPreviewMimeType, isBinaryFile } from '@/modules/code-editor';
import { api } from '@/shared/api';

export type FilePreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'markdown' | 'text';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
// Binary formats isBinaryFile does not list; anything else unlisted is sniffed for NUL bytes before it shows as text.
const UNPREVIEWABLE_EXTENSIONS = new Set(['psd', 'fbx', 'blend', 'exr', 'hdr', 'tga', 'tif', 'tiff', 'ttc', 'pdb', 'lib', 'obj', 'o', 'a']);

export const fileNameOf = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;

export function getFilePreviewKind(filePath: string): FilePreviewKind | null {
  const name = fileNameOf(filePath);
  const mediaKind = getPreviewKind(name);
  if (mediaKind) {
    return mediaKind;
  }
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return 'markdown';
  }
  return isBinaryFile(name) || UNPREVIEWABLE_EXTENSIONS.has(extension) ? null : 'text';
}

type LoadedPreview = { key: string; url: string | null; blob: Blob | null; failed: boolean };

/**
 * The file's bytes as a blob (and an object URL typed for the media element),
 * fetched with the auth header that a bare `src` could not carry. A blob also
 * lets `<video>`/`<audio>` seek without range requests.
 */
export function useFilePreviewBlob(localPath: string | null): { url: string | null; blob: Blob | null; failed: boolean } {
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const key = localPath ?? '';

  useEffect(() => {
    if (!localPath) {
      return;
    }
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await api.downloads.content(localPath, { signal: controller.signal });
        if (!response.ok) {
          setLoaded({ key, url: null, blob: null, failed: true });
          return;
        }
        const received = await response.blob();
        const expectedType = getPreviewMimeType(fileNameOf(localPath));
        const blob = expectedType && received.type !== expectedType ? new Blob([received], { type: expectedType }) : received;
        if (controller.signal.aborted) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl, blob, failed: false });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        setLoaded({ key, url: null, blob: null, failed: true });
      }
    };
    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [key, localPath]);

  const current = loaded && loaded.key === key ? loaded : null;
  return { url: current?.url ?? null, blob: current?.blob ?? null, failed: current?.failed ?? false };
}
