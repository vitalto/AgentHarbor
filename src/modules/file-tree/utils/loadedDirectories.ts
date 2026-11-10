import type { FileTreeNode } from '@/shared/types';

/** One folder's contents fetched on demand because the server tree left it unwalked. */
export type LoadedDirectory = {
  entries: FileTreeNode[];
  truncated: boolean;
};

export type DirectoryLoadState = {
  loaded: ReadonlyMap<string, LoadedDirectory>;
  loading: ReadonlySet<string>;
  failed: ReadonlyMap<string, string>;
};

export const EMPTY_DIRECTORY_LOAD_STATE: DirectoryLoadState = {
  loaded: new Map(),
  loading: new Set(),
  failed: new Map(),
};

/**
 * The tree as rendered: folders the server left unwalked (ignored ones, those
 * below the walk depth or past its size budget) get the contents fetched for
 * them so far, plus their loading or error state, and everything inside an
 * ignored folder is itself shown as ignored.
 */
export function mergeLoadedDirectories(
  nodes: FileTreeNode[],
  state: DirectoryLoadState,
  insideIgnoredDirectory = false,
): FileTreeNode[] {
  return nodes.map((node) => {
    const ignored = insideIgnoredDirectory || node.ignored === true;
    if (node.type !== 'directory') {
      return ignored === Boolean(node.ignored) ? node : { ...node, ignored };
    }

    const loadedDirectory = node.children ? null : state.loaded.get(node.path);
    const sourceChildren = node.children ?? loadedDirectory?.entries;
    const mergedNode: FileTreeNode = {
      ...node,
      ignored,
      children: sourceChildren ? mergeLoadedDirectories(sourceChildren, state, ignored) : undefined,
      childrenTruncated: node.childrenTruncated || loadedDirectory?.truncated || undefined,
      childrenLoading: state.loading.has(node.path) || undefined,
      childrenError: state.failed.get(node.path),
    };
    return mergedNode;
  });
}

/** Open folders in the rendered tree whose contents were never fetched and are not being fetched now. */
export function findUnloadedOpenDirectories(nodes: FileTreeNode[], expandedPaths: ReadonlySet<string>): string[] {
  const unloadedPaths: string[] = [];
  const visit = (levelNodes: FileTreeNode[]) => {
    for (const node of levelNodes) {
      if (node.type !== 'directory' || !expandedPaths.has(node.path)) {
        continue;
      }
      if (node.children) {
        visit(node.children);
      } else if (!node.childrenLoading && node.childrenError === undefined) {
        unloadedPaths.push(node.path);
      }
    }
  };
  visit(nodes);
  return unloadedPaths;
}
