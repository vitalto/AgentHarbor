import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { appConfigDb, projectsDb } from '@/modules/database/index.js';
import { toClaudePath, toLocalPath } from '@/modules/tmux/index.js';
import type { WorkspacePathValidationResult } from '@/shared/types.js';
import {
  AppError,
  WORKSPACES_ROOT,
  listWindowsDriveRoots,
  normalizeProjectPath,
  validateWorkspacePath,
} from '@/shared/utils.js';

const PROJECTS_DIRECTORY_CONFIG_KEY = 'workspace.projects_directory';

/** A place the folder browser can jump to: the home folder or a Windows drive. */
type WorkspacePlace = {
  label: string;
  path: string;
};

/** A folder directly inside the projects directory; `projectId` is set when it is already an active project. */
type ProjectsDirectoryFolder = {
  name: string;
  path: string;
  projectId: string | null;
};

export type WorkspaceLocations = {
  /** The folder new projects usually go into (e.g. `D:\Develop`), or `null` when none is set. */
  projectsDirectory: string | null;
  projectsDirectoryFolders: ProjectsDirectoryFolder[];
  places: WorkspacePlace[];
};

type WorkspaceLocationsDependencies = {
  readStoredProjectsDirectory: () => string | null;
  storeProjectsDirectory: (localPath: string | null) => void;
  /** `AH_PROJECTS_DIR`: the projects directory until one is chosen in the UI. */
  defaultProjectsDirectory: string | null;
  homeDirectory: string;
  listDriveRoots: () => Promise<string[]>;
  listSubdirectoryNames: (directoryPath: string) => Promise<string[]>;
  isDirectory: (directoryPath: string) => Promise<boolean>;
  listActiveProjects: () => Array<{ project_id: string; project_path: string }>;
  validatePath: (candidatePath: string) => Promise<WorkspacePathValidationResult>;
  toLocalPath: (displayPath: string) => string;
  toDisplayPath: (localPath: string) => string;
};

const MOUNTED_DRIVE_ROOT = /^\/mnt\/([a-z])$/;

const defaultDependencies: WorkspaceLocationsDependencies = {
  readStoredProjectsDirectory: () => appConfigDb.get(PROJECTS_DIRECTORY_CONFIG_KEY),
  storeProjectsDirectory: (localPath) => {
    if (localPath === null) {
      appConfigDb.remove(PROJECTS_DIRECTORY_CONFIG_KEY);
    } else {
      appConfigDb.set(PROJECTS_DIRECTORY_CONFIG_KEY, localPath);
    }
  },
  defaultProjectsDirectory: process.env.AH_PROJECTS_DIR?.trim() || null,
  homeDirectory: WORKSPACES_ROOT,
  listDriveRoots: () => listWindowsDriveRoots(),
  listSubdirectoryNames: async (directoryPath) => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  isDirectory: async (directoryPath) => {
    try {
      return (await stat(directoryPath)).isDirectory();
    } catch {
      return false;
    }
  },
  listActiveProjects: () => projectsDb.getProjectPaths(),
  validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
  toLocalPath: (displayPath) => toLocalPath(displayPath),
  toDisplayPath: (localPath) => toClaudePath(localPath),
};

// Windows drives ignore case, and a project registered from a Windows Claude
// may carry a different case than the folder listing.
function projectPathKey(localPath: string): string {
  const normalizedPath = normalizeProjectPath(localPath);
  return normalizedPath.startsWith('/mnt/') ? normalizedPath.toLowerCase() : normalizedPath;
}

export function createWorkspaceLocationsService(
  dependencies: WorkspaceLocationsDependencies = defaultDependencies,
) {
  function resolveProjectsDirectory(): string | null {
    const configuredPath = dependencies.readStoredProjectsDirectory() ?? dependencies.defaultProjectsDirectory;
    return configuredPath ? normalizeProjectPath(dependencies.toLocalPath(configuredPath)) : null;
  }

  async function listProjectsDirectoryFolders(projectsDirectory: string): Promise<ProjectsDirectoryFolder[]> {
    let folderNames: string[];
    try {
      folderNames = await dependencies.listSubdirectoryNames(projectsDirectory);
    } catch {
      return [];
    }

    const projectIdsByPath = new Map(
      dependencies.listActiveProjects().map((project) => [projectPathKey(project.project_path), project.project_id]),
    );

    return folderNames
      .filter((name) => !name.startsWith('.'))
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }))
      .map((name) => {
        const localPath = path.posix.join(projectsDirectory, name);
        return {
          name,
          path: dependencies.toDisplayPath(localPath),
          projectId: projectIdsByPath.get(projectPathKey(localPath)) ?? null,
        };
      });
  }

  async function listPlaces(): Promise<WorkspacePlace[]> {
    const driveRoots = await dependencies.listDriveRoots();
    return [
      { label: '~', path: dependencies.toDisplayPath(dependencies.homeDirectory) },
      ...driveRoots.map((driveRoot) => {
        const letter = MOUNTED_DRIVE_ROOT.exec(driveRoot)?.[1]?.toUpperCase();
        return {
          label: letter ? `${letter}:` : path.posix.basename(driveRoot),
          path: dependencies.toDisplayPath(driveRoot),
        };
      }),
    ];
  }

  async function getLocations(): Promise<WorkspaceLocations> {
    const projectsDirectory = resolveProjectsDirectory();
    return {
      projectsDirectory: projectsDirectory ? dependencies.toDisplayPath(projectsDirectory) : null,
      projectsDirectoryFolders: projectsDirectory ? await listProjectsDirectoryFolders(projectsDirectory) : [],
      places: await listPlaces(),
    };
  }

  /** `null` forgets the chosen folder, falling back to `AH_PROJECTS_DIR`. */
  async function setProjectsDirectory(requestedPath: string | null): Promise<WorkspaceLocations> {
    if (requestedPath === null) {
      dependencies.storeProjectsDirectory(null);
      return getLocations();
    }

    const localPath = dependencies.toLocalPath(requestedPath.trim());
    const validation = await dependencies.validatePath(localPath);
    if (!validation.valid || !validation.resolvedPath) {
      throw new AppError('Invalid projects folder', {
        code: 'INVALID_PROJECTS_DIRECTORY',
        statusCode: 400,
        details: validation.error ?? 'Path validation failed',
      });
    }
    if (!await dependencies.isDirectory(validation.resolvedPath)) {
      throw new AppError('The projects folder does not exist', {
        code: 'PROJECTS_DIRECTORY_NOT_FOUND',
        statusCode: 400,
        details: `Not a folder: ${requestedPath}`,
      });
    }

    dependencies.storeProjectsDirectory(normalizeProjectPath(validation.resolvedPath));
    return getLocations();
  }

  return { getLocations, setProjectsDirectory };
}

export const workspaceLocationsService = createWorkspaceLocationsService();
