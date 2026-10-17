import { useCallback, useEffect, useState } from 'react';

import {
  fetchWorkspaceLocations,
  saveProjectsDirectory,
  type WorkspaceLocations,
} from '@/modules/project-creation-wizard/utils/workspaceApi';

/** The projects folder with its subfolders and the places the folder browser can jump to. */
export function useWorkspaceLocations() {
  const [locations, setLocations] = useState<WorkspaceLocations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWorkspaceLocations()
      .then((loaded) => {
        if (!cancelled) {
          setLocations(loaded);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError((loadError as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeProjectsDirectory = useCallback(async (directoryPath: string) => {
    setLoading(true);
    setError(null);
    try {
      setLocations(await saveProjectsDirectory(directoryPath));
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { locations, loading, error, changeProjectsDirectory };
}
