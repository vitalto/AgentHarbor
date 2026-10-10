// An agent "sends" a file by writing its absolute path; the chat turns every
// such path into a download button. Only paths ending in a file extension
// qualify, so directories and project-relative references are left alone.
// Linux roots are limited to the ones a Windows-hosted agent writes into
// (WSL mounts, homes, temp), so URL paths like `/api/data.json` stay plain text.

const FILE_EXTENSION = String.raw`\.[A-Za-z0-9]{1,10}`;
const WINDOWS_ROOT = String.raw`[A-Za-z]:[\\/]`;
const LINUX_ROOT = String.raw`/(?:mnt|home|tmp|root)/`;

const WHOLE_VALUE_PATH = new RegExp(
  String.raw`^(?:${WINDOWS_ROOT}|${LINUX_ROOT})[^\0\r\n"<>|*?]*${FILE_EXTENSION}$`,
);

// Prose cannot delimit spaces inside a path, so a path in plain text ends at the
// first whitespace or bracket; paths with spaces are found in `code` spans.
const PATH_IN_PROSE = new RegExp(
  String.raw`(?<![\w/\\])(?:${WINDOWS_ROOT}|${LINUX_ROOT})[^\s"'<>|*?\`()[\]{}]*${FILE_EXTENSION}(?![\w-])`,
  'g',
);

const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/** The file a whole code span or link names (`D:\out\report.pdf:12` → `D:\out\report.pdf`), or null. */
export function asDownloadablePath(value: string): string | null {
  const candidate = value.trim().replace(LINE_SUFFIX, '');
  return WHOLE_VALUE_PATH.test(candidate) ? candidate : null;
}

export type PathMatch = { start: number; end: number; path: string };

export function findDownloadablePathsInProse(text: string): PathMatch[] {
  return Array.from(text.matchAll(PATH_IN_PROSE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    path: match[0],
  }));
}

/** Exactly the drive-letter paths react-markdown's URL sanitizer would blank as an unknown `c:` scheme. */
export const isWindowsDrivePath = (url: string): boolean => new RegExp(`^${WINDOWS_ROOT}`).test(url);
