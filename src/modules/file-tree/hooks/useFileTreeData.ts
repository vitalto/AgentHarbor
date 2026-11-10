import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { FileTreeDirectoryListing, FileTreeLocation, FileTreeNode, Project } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  /** Where the tree is rooted; null until the server has described it. */
  location: FileTreeLocation | null;
  /** The root folder held more entries than one listing returns. */
  rootTruncated: boolean;
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  /** Bumped by every refresh, so folders fetched on demand are read again too. */
  refreshKey: number;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals as { error: message }. Surfacing that message tells
// the user why the tree is missing, instead of an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

async function fetchProjectTree(projectId: string, signal: AbortSignal) {
  const [treeResponse, location] = await Promise.all([
    api.getFileTreeWithIgnored(projectId, { signal }),
    // The location only labels the bar; a failure there must not hide the tree.
    api.getFileTreeLocation(projectId, null, { signal })
      .then((response) => readApiJson<FileTreeLocation>(response))
      .catch(() => null),
  ]);
  if (!treeResponse.ok) {
    throw new Error(readResponseErrorMessage(await treeResponse.text()) ?? DEFAULT_LOAD_ERROR);
  }
  return { files: (await treeResponse.json()) as FileTreeNode[], location, rootTruncated: false };
}

async function fetchBrowsedDirectory(projectId: string, directoryPath: string, signal: AbortSignal) {
  const response = await api.getFileTreeDirectory(projectId, directoryPath, { signal });
  if (!response.ok) {
    throw new Error(readResponseErrorMessage(await response.text()) ?? DEFAULT_LOAD_ERROR);
  }
  const { entries, truncated, ...location } = (await response.json()) as FileTreeDirectoryListing;
  return { files: entries, location, rootTruncated: truncated };
}

/**
 * Loads the tree's root: the project (walked by the server, ignored entries
 * flagged and left unwalked) or, with `browsedPath`, one folder anywhere on
 * the machine whose subfolders are all fetched on demand.
 */
export function useFileTreeData(selectedProject: Project | null, browsedPath: string | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [location, setLocation] = useState<FileTreeLocation | null>(null);
  const [rootTruncated, setRootTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setFiles([]);
      setLocation(null);
      setLoading(false);
      setError(null);
      return;
    }

    const abortController = new AbortController();
    let isActive = true;

    const fetchRoot = async () => {
      setLoading(true);
      setError(null);
      // The previous root's location must not describe the folder being opened.
      setLocation(null);
      try {
        const result = browsedPath
          ? await fetchBrowsedDirectory(projectId, browsedPath, abortController.signal)
          : await fetchProjectTree(projectId, abortController.signal);
        if (isActive) {
          setFiles(result.files);
          setLocation(result.location);
          setRootTruncated(result.rootTruncated);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }
        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setLocation(null);
          setRootTruncated(false);
          setError(error instanceof Error && error.message ? error.message : DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchRoot();

    return () => {
      isActive = false;
      abortController.abort();
    };
  }, [selectedProject?.projectId, browsedPath, refreshKey]);

  return {
    files,
    location,
    rootTruncated,
    loading,
    error,
    refreshFiles,
    refreshKey,
  };
}
