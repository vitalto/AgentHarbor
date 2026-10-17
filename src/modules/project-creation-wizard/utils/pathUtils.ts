import type { WorkspacePlace } from '@/modules/project-creation-wizard/utils/workspaceApi';

const SSH_PREFIXES = ['git@', 'ssh://'];
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\\?$/;

export const isSshGitUrl = (url: string): boolean => {
  const trimmedUrl = url.trim();
  return SSH_PREFIXES.some((prefix) => trimmedUrl.startsWith(prefix));
};

export const shouldShowGithubAuthentication = (githubUrl: string): boolean =>
  githubUrl.trim().length > 0 && !isSshGitUrl(githubUrl);

export const isCloneWorkflow = (githubUrl: string): boolean =>
  githubUrl.trim().length > 0;

export const getSuggestionRootPath = (inputPath: string): string => {
  const trimmedPath = inputPath.trim();
  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'));
  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(trimmedPath)) {
    return `${trimmedPath.slice(0, 2)}\\`;
  }

  return lastSeparatorIndex > 0 ? trimmedPath.slice(0, lastSeparatorIndex) : '~';
};

// Handles root edge cases for Unix-like and Windows paths.
export const getParentPath = (currentPath: string): string | null => {
  if (currentPath === '~' || currentPath === '/' || WINDOWS_DRIVE_PATTERN.test(currentPath)) {
    return null;
  }

  const lastSeparatorIndex = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  if (lastSeparatorIndex <= 0) {
    return '/';
  }

  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(currentPath)) {
    return `${currentPath.slice(0, 2)}\\`;
  }

  return currentPath.slice(0, lastSeparatorIndex);
};

export const joinFolderPath = (basePath: string, folderName: string): string => {
  const normalizedBasePath = basePath.trim().replace(/[\\/]+$/, '');
  const separator =
    normalizedBasePath.includes('\\') && !normalizedBasePath.includes('/') ? '\\' : '/';
  return `${normalizedBasePath}${separator}${folderName.trim()}`;
};

// Windows forbids these characters and a trailing dot or space; the stricter
// rule is used everywhere so a name never depends on which side creates it.
const FORBIDDEN_FOLDER_NAME_CHARACTERS = /[\\/:*?"<>|]/;

export const isValidFolderName = (name: string): boolean => {
  const trimmedName = name.trim();
  return (
    trimmedName.length > 0
    && trimmedName !== '.'
    && trimmedName !== '..'
    && !FORBIDDEN_FOLDER_NAME_CHARACTERS.test(trimmedName)
    && !/[. ]$/.test(trimmedName)
  );
};

export const getFolderName = (folderPath: string): string =>
  folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath;

/** Puts the projects folder (labelled by its name, e.g. "Develop") in front of the browser's places. */
export const withProjectsDirectoryPlace = (
  projectsDirectory: string | null,
  places: WorkspacePlace[],
): WorkspacePlace[] =>
  projectsDirectory ? [{ label: getFolderName(projectsDirectory), path: projectsDirectory }, ...places] : places;
