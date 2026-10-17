import { isValidFolderName } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { ProjectsDirectoryFolder } from '@/modules/project-creation-wizard/utils/workspaceApi';

export type ProjectsDirectoryMatches = {
  folders: ProjectsDirectoryFolder[];
  /** The query as the name of a folder to create, when it is a valid name no existing folder already has. */
  newFolderName: string | null;
};

/** Folders whose name starts with the query come first, then those that merely contain it. */
export function matchProjectsDirectoryFolders(
  folders: ProjectsDirectoryFolder[],
  query: string,
): ProjectsDirectoryMatches {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { folders, newFolderName: null };
  }

  const loweredQuery = trimmedQuery.toLowerCase();
  const prefixMatches: ProjectsDirectoryFolder[] = [];
  const innerMatches: ProjectsDirectoryFolder[] = [];
  for (const folder of folders) {
    const loweredName = folder.name.toLowerCase();
    if (loweredName.startsWith(loweredQuery)) {
      prefixMatches.push(folder);
    } else if (loweredName.includes(loweredQuery)) {
      innerMatches.push(folder);
    }
  }

  // Windows folder names ignore case, so "myapp" would land in an existing "MyApp".
  const nameTaken = folders.some((folder) => folder.name.toLowerCase() === loweredQuery);
  return {
    folders: [...prefixMatches, ...innerMatches],
    newFolderName: !nameTaken && isValidFolderName(trimmedQuery) ? trimmedQuery : null,
  };
}
