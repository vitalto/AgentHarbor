import { findFileReferencesInProse } from '@/modules/chat/utils/downloadablePaths';

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

// Inside these the text already belongs to a link, so wrapping it again would nest anchors.
const LINK_NODE_TYPES = new Set(['link', 'linkReference']);

function splitTextAroundPaths(text: string): MarkdownNode[] | null {
  const matches = findFileReferencesInProse(text);
  if (matches.length === 0) {
    return null;
  }

  const pieces: MarkdownNode[] = [];
  let cursor = 0;
  for (const { start, end, path } of matches) {
    if (start > cursor) {
      pieces.push({ type: 'text', value: text.slice(cursor, start) });
    }
    pieces.push({ type: 'link', url: path, children: [{ type: 'text', value: path }] });
    cursor = end;
  }
  if (cursor < text.length) {
    pieces.push({ type: 'text', value: text.slice(cursor) });
  }
  return pieces;
}

function linkPathsInChildren(node: MarkdownNode) {
  if (!node.children || LINK_NODE_TYPES.has(node.type)) {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) {
      return splitTextAroundPaths(child.value) ?? [child];
    }
    linkPathsInChildren(child);
    return [child];
  });
}

/** Turns file paths written as plain prose into links, which the `a` renderer gives the file actions. */
export function remarkDownloadablePaths() {
  return (tree: MarkdownNode) => linkPathsInChildren(tree);
}
