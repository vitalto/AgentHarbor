// An agent "sends" a file by writing its path; the chat gives every path that
// names a real file a download button and, for types the browser can show, a
// preview. Paths are absolute, relative to the project (`docs/plan.md`) or
// shortened with an ellipsis (`…\scratchpad\shot.png`); the server finds the
// file behind each and the actions appear only when it exists.
// Only paths ending in a file extension qualify, so directories are left alone.
// Linux roots are limited to the ones a Windows-hosted agent writes into
// (WSL mounts, homes, temp), so URL paths like `/api/data.json` stay plain text.

// At least one letter, so version numbers like `0.3.0` are not taken for files.
const FILE_EXTENSION = String.raw`\.(?=[A-Za-z0-9]{0,9}[A-Za-z])[A-Za-z0-9]{1,10}`;
const WINDOWS_ROOT = String.raw`[A-Za-z]:[\\/]`;
const LINUX_ROOT = String.raw`/(?:mnt|home|tmp|root)/`;
const ELLIPSIS_PREFIX = String.raw`(?:…|\.\.\.)[\\/]`;
// `\w` is ASCII-only without the `u` flag, which the backtick escape below rules out.
const NAME_CHAR = String.raw`\wÀ-ɏЀ-ӿ`;

const WHOLE_VALUE_ABSOLUTE_PATH = new RegExp(
  String.raw`^(?:${WINDOWS_ROOT}|${LINUX_ROOT})[^\0\r\n"<>|*?]*${FILE_EXTENSION}$`,
);

// A code span or link holds nothing but the path, so a bare `Floor7.exe` counts too.
const WHOLE_VALUE_RELATIVE_PATH = new RegExp(
  String.raw`^(?:${ELLIPSIS_PREFIX})?(?![\\/@~])[^\0\r\n"<>|*?:=;{}]*${FILE_EXTENSION}$`,
);

// Prose cannot delimit spaces inside a path, so a path in plain text ends at the
// first whitespace or bracket; paths with spaces are found in `code` spans. A
// relative path in prose needs a separator, or every `e.g.` and `Node.js` would match.
const ABSOLUTE_PATH_IN_PROSE = String.raw`(?:${WINDOWS_ROOT}|${LINUX_ROOT})[^\s"'<>|*?\`()[\]{}]*${FILE_EXTENSION}`;
const RELATIVE_PATH_IN_PROSE = String.raw`(?:${ELLIPSIS_PREFIX}|\.[\\/])?[${NAME_CHAR}-][${NAME_CHAR}.-]*(?:[\\/][${NAME_CHAR}.-]+)*[\\/][${NAME_CHAR}.-]*${FILE_EXTENSION}`;
const PATH_IN_PROSE = new RegExp(
  String.raw`(?<![${NAME_CHAR}/\\.…:])(?:${ABSOLUTE_PATH_IN_PROSE}|${RELATIVE_PATH_IN_PROSE})(?![${NAME_CHAR}-])`,
  'g',
);

const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The file a whole code span or link names (`docs\plan.md:12` → `docs\plan.md`), or null. */
export function asFileReference(value: string): string | null {
  const candidate = value.trim().replace(LINE_SUFFIX, '');
  if (URL_SCHEME.test(candidate)) {
    return null;
  }
  return WHOLE_VALUE_ABSOLUTE_PATH.test(candidate) || WHOLE_VALUE_RELATIVE_PATH.test(candidate) ? candidate : null;
}

export type PathMatch = { start: number; end: number; path: string };

export function findFileReferencesInProse(text: string): PathMatch[] {
  return Array.from(text.matchAll(PATH_IN_PROSE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    path: match[0],
  }));
}

/** Exactly the drive-letter paths react-markdown's URL sanitizer would blank as an unknown `c:` scheme. */
export const isWindowsDrivePath = (url: string): boolean => new RegExp(`^${WINDOWS_ROOT}`).test(url);
