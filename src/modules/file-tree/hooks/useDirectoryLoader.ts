import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { FileTreeDirectoryListing } from '@/shared/types';
import {
  EMPTY_DIRECTORY_LOAD_STATE,
  type DirectoryLoadState,
} from '@/modules/file-tree/utils/loadedDirectories';

type ScopedDirectoryLoadState = DirectoryLoadState & { scope: string };

const DEFAULT_FOLDER_ERROR = 'Unable to open this folder.';

/**
 * Fetches the contents of folders the server tree left unwalked, one folder at
 * a time as the user opens it. Everything fetched belongs to `scope` (the
 * project and tree refresh it was read for) and is dropped when that changes.
 */
export function useDirectoryLoader(projectId: string | null | undefined, scope: string) {
  const [scopedState, setScopedState] = useState<ScopedDirectoryLoadState>(() => ({
    ...EMPTY_DIRECTORY_LOAD_STATE,
    scope,
  }));
  const state: DirectoryLoadState = scopedState.scope === scope ? scopedState : EMPTY_DIRECTORY_LOAD_STATE;

  const currentScopeRef = useRef(scope);
  const requestedPathsRef = useRef(new Set<string>());
  useEffect(() => {
    currentScopeRef.current = scope;
    requestedPathsRef.current = new Set();
  }, [scope]);

  const updateState = useCallback((requestScope: string, update: (previous: DirectoryLoadState) => DirectoryLoadState) => {
    setScopedState((previous) => {
      if (requestScope !== currentScopeRef.current) {
        return previous;
      }
      const base = previous.scope === requestScope ? previous : EMPTY_DIRECTORY_LOAD_STATE;
      return { ...update(base), scope: requestScope };
    });
  }, []);

  const loadDirectory = useCallback((directoryPath: string) => {
    if (!projectId || requestedPathsRef.current.has(directoryPath)) {
      return;
    }
    requestedPathsRef.current.add(directoryPath);
    const requestScope = currentScopeRef.current;

    updateState(requestScope, (previous) => ({
      ...previous,
      loading: new Set(previous.loading).add(directoryPath),
    }));

    const finish = (applyResult: (previous: DirectoryLoadState) => Partial<DirectoryLoadState>) => {
      updateState(requestScope, (previous) => {
        const loading = new Set(previous.loading);
        loading.delete(directoryPath);
        return { ...previous, loading, ...applyResult(previous) };
      });
    };

    void (async () => {
      try {
        const listing = await readApiJson<FileTreeDirectoryListing>(await api.getFileTreeDirectory(projectId, directoryPath));
        finish((previous) => ({
          loaded: new Map(previous.loaded).set(directoryPath, { entries: listing.entries, truncated: listing.truncated }),
        }));
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : DEFAULT_FOLDER_ERROR;
        finish((previous) => ({ failed: new Map(previous.failed).set(directoryPath, message) }));
      }
    })();
  }, [projectId, updateState]);

  return { directoryLoadState: state, loadDirectory };
}
