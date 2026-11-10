import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeLocation,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError, FORBIDDEN_WORKSPACE_PATHS, normalizeProjectPath } from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// The project walk stops descending once this many entries are in the tree so a
// very broad project (a home directory, a whole drive) cannot exhaust the
// server heap; folders past the budget are left for the browser to open on demand.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

// One directory listing never holds more than this many entries, so a folder
// with millions of children is abandoned mid-stream instead of materialized.
const MAXIMUM_DIRECTORY_ENTRIES = 5_000;

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

type FileTreeWalk = {
  maximumDepth: number;
  /** Entries it accepts are listed; the rest are left out of the response. */
  includeEntry: FileTreeEntryFilter;
  /** Listed entries it accepts are marked `ignored` and never descended into. */
  isIgnoredEntry: FileTreeEntryFilter | null;
  remainingEntries: { value: number };
};

type FileTreeListing = {
  nodes: FileTreeNode[];
  truncated: boolean;
};

function includeEveryEntry(): boolean {
  return true;
}

function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const rootWithSeparator = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(rootWithSeparator);
}

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * Streams one directory and keeps the entries `includeEntry` accepts,
   * stopping at `MAXIMUM_DIRECTORY_ENTRIES` so a pathologically large
   * directory is never read into memory in full.
   */
  async function collectDirectoryEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
  ): Promise<{ entries: FileTreeDirectoryEntry[]; truncated: boolean }> {
    const entries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        if (!includeEntry(path.join(directoryPath, entry.name), entry.isDirectory())) {
          continue;
        }
        if (entries.length >= MAXIMUM_DIRECTORY_ENTRIES) {
          return { entries, truncated: true };
        }
        entries.push(entry);
      }
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return { entries: [], truncated: false };
    } finally {
      release();
    }

    return { entries, truncated: false };
  }

  async function describeEntry(
    directoryPath: string,
    entry: FileTreeDirectoryEntry,
    isIgnored: boolean,
  ): Promise<FileTreeNode> {
    const itemPath = path.join(directoryPath, entry.name);
    const item: FileTreeNode = {
      name: entry.name,
      path: itemPath,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: 0,
      modified: null,
      permissions: '000',
      permissionsRwx: '---------',
    };
    if (isIgnored) {
      item.ignored = true;
    }

    try {
      await acquire();
      try {
        const stats = await fileSystem.lstat(itemPath);
        const ownerPermissions = (stats.mode >> 6) & 7;
        const groupPermissions = (stats.mode >> 3) & 7;
        const otherPermissions = stats.mode & 7;

        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
        item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
          + permissionBitsToRwx(groupPermissions)
          + permissionBitsToRwx(otherPermissions);
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }
      } finally {
        release();
      }
    } catch {
      // Metadata failures should not hide an otherwise readable tree entry.
    }

    return item;
  }

  /**
   * Lists `directoryPath` and, down to `walk.maximumDepth`, the folders in it.
   *
   * A nested folder whose listing does not fit the remaining entry budget comes
   * back as null, so its node keeps no `children`: the browser reads such a
   * folder, like an ignored one, through `listDirectory` once it is opened.
   */
  async function buildFileTree(
    directoryPath: string,
    walk: FileTreeWalk,
    currentDepth = 0,
  ): Promise<FileTreeListing | null> {
    const { entries, truncated } = await collectDirectoryEntries(directoryPath, walk.includeEntry);
    if (currentDepth > 0 && entries.length > walk.remainingEntries.value) {
      return null;
    }
    walk.remainingEntries.value -= entries.length;

    const nodes = await Promise.all(entries.map(async (entry): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const isIgnored = walk.isIgnoredEntry?.(itemPath, entry.isDirectory()) ?? false;
      const item = await describeEntry(directoryPath, entry, isIgnored);

      // Skip recursing into pseudo-filesystems and other system-critical
      // directories (e.g. /proc, /sys) — they're never valid project roots,
      // and /proc in particular can contain thousands of virtual entries
      // that make traversal from a broad root (e.g. "/") pathologically slow.
      const isForbiddenSystemDir = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(itemPath));

      if (item.type === 'directory' && !isIgnored && currentDepth < walk.maximumDepth && !isForbiddenSystemDir) {
        const childListing = await buildFileTree(itemPath, walk, currentDepth + 1);
        if (childListing) {
          item.children = childListing.nodes;
          if (childListing.truncated) {
            item.childrenTruncated = true;
          }
        }
      }

      return item;
    }));

    nodes.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    return { nodes, truncated };
  }

  /** Lists one directory without descending; a single directory is never refused for size. */
  async function listOneLevel(directoryPath: string, includeEntry: FileTreeEntryFilter, isIgnoredEntry: FileTreeEntryFilter | null) {
    const listing = await buildFileTree(directoryPath, {
      maximumDepth: 0,
      includeEntry,
      isIgnoredEntry,
      remainingEntries: { value: Number.POSITIVE_INFINITY },
    });
    return listing ?? { nodes: [], truncated: false };
  }

  /**
   * The project's ignore rules as a predicate over absolute paths: its root
   * `.gitignore` plus the always-excluded VCS and dependency folders, or the
   * conventional build/cache folder names when there is no `.gitignore`.
   */
  async function loadProjectIgnoreRules(projectRoot: string, respectGitignore: boolean): Promise<FileTreeEntryFilter> {
    let includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames;
    if (respectGitignore) {
      try {
        const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
        includeEntry = createGitignoreEntryFilter(projectRoot, gitignoreContent);
      } catch (error) {
        if (readErrorCode(error) !== 'ENOENT') {
          dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
        }
      }
    }
    return (entryPath, isDirectory) => !includeEntry(entryPath, isDirectory);
  }

  function describeLocation(projectRoot: string, directoryPath: string): FileTreeLocation {
    const parentPath = path.dirname(directoryPath);
    return {
      path: directoryPath,
      displayPath: dependencies.workspace.toDisplayPath(directoryPath),
      parentPath: parentPath === directoryPath ? null : parentPath,
      insideProject: isPathInsideOrEqual(projectRoot, directoryPath),
    };
  }

  /** Any absolute path, as the server or a Windows Claude writes it; a relative one is taken from the project root. */
  function resolveListablePath(projectRoot: string, targetPath: string | null): string {
    if (!targetPath?.trim()) {
      return path.resolve(projectRoot);
    }
    const localPath = dependencies.workspace.toLocalPath(targetPath.trim());
    return path.isAbsolute(localPath) ? path.resolve(localPath) : path.resolve(projectRoot, localPath);
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer may read. A chat tool card opens whatever file
   * an agent touched, wherever it lives (a render under C:\AI, a log in the
   * temp directory), and whoever is signed in can already read all of it
   * through the downloads API and the shell, so any absolute path is allowed.
   * A relative path belongs to the project. The writing endpoints use
   * `resolvePathInsideProject` alone, so nothing outside the project can be changed.
   */
  function resolveReadablePath(projectRoot: string, targetPath: string): string {
    return path.isAbsolute(targetPath) ? path.resolve(targetPath) : resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, dependencies.workspace.toLocalPath(inputPath))
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const { nodes: fileTree } = await listOneLevel(resolvedPath, includeEntryByFallbackDirectoryNames, null);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: dependencies.workspace.toDisplayPath(item.path), name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: dependencies.workspace.toDisplayPath(resolvedPath), suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, dependencies.workspace.toLocalPath(folderPath));
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: dependencies.workspace.toDisplayPath(targetPath) };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolveReadablePath(projectRoot, dependencies.workspace.toLocalPath(filePath));
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolveReadablePath(projectRoot, dependencies.workspace.toLocalPath(filePath));
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, dependencies.workspace.toLocalPath(filePath));
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const isIgnoredEntry = await loadProjectIgnoreRules(projectRoot, options?.respectGitignore ?? false);
      const includeIgnored = options?.includeIgnored ?? false;
      const listing = await buildFileTree(projectRoot, {
        maximumDepth: 10,
        includeEntry: includeIgnored
          ? includeEveryEntry
          : (entryPath, isDirectory) => !isIgnoredEntry(entryPath, isDirectory),
        isIgnoredEntry: includeIgnored ? isIgnoredEntry : null,
        remainingEntries: { value: MAXIMUM_FILE_TREE_ENTRIES },
      });
      return listing?.nodes ?? [];
    },

    async describeDirectory(projectId, targetPath) {
      const projectRoot = await resolveProjectRoot(projectId);
      return describeLocation(projectRoot, resolveListablePath(projectRoot, targetPath));
    },

    async listDirectory(projectId, targetPath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const directoryPath = resolveListablePath(projectRoot, targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(directoryPath);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'Folder not found', statusCode: 404 },
          ENOTDIR: { message: 'Path is not a folder', statusCode: 400 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EPERM: { message: 'Permission denied', statusCode: 403 },
        });
      }
      if (!stats.isDirectory()) {
        throw createFileTreeError('Path is not a folder', 400, 'NOT_A_DIRECTORY');
      }

      const isIgnoredEntry = isPathInsideOrEqual(projectRoot, directoryPath)
        ? await loadProjectIgnoreRules(projectRoot, true)
        : (entryPath: string, isDirectory: boolean) => !includeEntryByFallbackDirectoryNames(entryPath, isDirectory);
      const listing = await listOneLevel(directoryPath, includeEveryEntry, isIgnoredEntry);

      return {
        ...describeLocation(projectRoot, directoryPath),
        entries: listing.nodes,
        truncated: listing.truncated,
      };
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
