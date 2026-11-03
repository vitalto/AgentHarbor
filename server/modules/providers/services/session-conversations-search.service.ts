import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { spawn } from 'cross-spawn';
import { rgPath } from '@vscode/ripgrep';

import { stripAnsiSequences } from '@/shared/utils.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  buildQuerySnippet,
  matchQueryTerms,
  parseConversationSearchQuery,
  type ConversationSearchQuery,
  type SearchSnippetHighlight,
} from '@/modules/providers/services/conversation-search-query.js';

type AnyRecord = Record<string, any>;
type SearchableProvider = 'claude';

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: SearchableProvider;
  messageUuid?: string | null;
};

type RankedSessionMatch = SessionConversationMatch & {
  /** How many different query terms the message contains. */
  score: number;
};

type SessionConversationResult = {
  sessionId: string;
  provider: SearchableProvider;
  sessionSummary: string;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

type SessionTitleSearchResult = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  signal?: AbortSignal;
  onTitleResults?: (results: SessionTitleSearchResult[]) => void;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];
type SearchableSessionRow = SessionRepositoryRow & {
  provider: SearchableProvider;
  jsonl_path: string;
};

type SearchablePathEntry = {
  normalizedPath: string;
  absolutePath: string;
};

type ProjectBucket = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SearchableSessionRow[];
};

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude']);
const MAX_MATCHES_PER_SESSION = 2;
const RIPGREP_FILE_CHUNK_SIZE = 40;
const RIPGREP_CHUNK_CONCURRENCY = 6;
// Longer transcript lines are tool output and injected context; real chat
// messages fit, and printing those lines would multiply the bytes to parse.
const RIPGREP_MAX_LINE_LENGTH = 100_000;
const RIPGREP_OMITTED_LINE_PREFIX = '[Omitted long line';
const UNKNOWN_PROJECT_KEY = '__unknown_project__';

const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  'Invalid API key',
  '[Request interrupted',
] as const;

function normalizeComparablePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());
  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: TItem[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName) {
    return trimmedCustomName;
  }

  const trimmedFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!trimmedFallback) {
    return emptyLabel;
  }

  return trimmedFallback.length > 50 ? `${trimmedFallback.slice(0, 50)}...` : trimmedFallback;
}

/**
 * Finds visible sessions whose displayed title contains every query term.
 * Title matches are resolved from the database before transcript scanning so
 * the UI can always present them first, including sessions without a
 * transcript yet.
 */
function findSessionTitleResults(
  sessions: SessionRepositoryRow[],
  query: ConversationSearchQuery,
  limit: number,
): SessionTitleSearchResult[] {
  const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

  return sessions
    .flatMap((session) => {
      const sessionTitle = toSummaryText(session.custom_name, session.session_id, session.session_id);
      const titleMatch = matchQueryTerms(query, sessionTitle);
      if (titleMatch.matchedTermIndexes.length < query.terms.length) {
        return [];
      }
      const matchIndex = titleMatch.firstMatchIndex;

      const projectPath = typeof session.project_path === 'string' && session.project_path.trim()
        ? session.project_path.trim()
        : null;
      const projectKey = projectPath ?? UNKNOWN_PROJECT_KEY;
      if (!projectCache.has(projectKey)) {
        projectCache.set(
          projectKey,
          projectPath ? projectsDb.getProjectPath(projectPath) : null,
        );
      }

      const project = projectCache.get(projectKey) ?? null;
      if (project?.isArchived) {
        return [];
      }

      return [{
        sessionId: session.session_id,
        provider: session.provider,
        projectId: project?.project_id ?? null,
        projectDisplayName: projectPath
          ? (project?.custom_project_name?.trim() || path.basename(projectPath) || projectPath)
          : 'Unknown Project',
        sessionTitle,
        lastActivity: session.updated_at || session.created_at || null,
        matchIndex,
      }];
    })
    .sort((left, right) => {
      if (left.matchIndex !== right.matchIndex) {
        return left.matchIndex - right.matchIndex;
      }

      return new Date(right.lastActivity ?? 0).getTime() - new Date(left.lastActivity ?? 0).getTime();
    })
    .slice(0, limit)
    .map(({ matchIndex: _matchIndex, ...result }) => result);
}

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  // A prompt sent with attachments or hook output is an array in which
  // system reminders can come first; dropping only those parts keeps the
  // prompt itself searchable.
  return content
    .filter((part: AnyRecord) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: AnyRecord) => String(part.text))
    .filter((text) => !isInternalContent(text))
    .join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

type ClaudeSearchableMessage = {
  text: string;
  role: 'user' | 'assistant';
};

/**
 * Claude mixes visible chat, compact summaries, and local command wrappers into
 * the same transcript stream. Search should operate on the user-visible meaning
 * of those rows rather than the raw wrapper syntax.
 */
function extractClaudeSearchableMessage(entry: AnyRecord): ClaudeSearchableMessage | null {
  // Conversation turns only: Claude Code 2.1.302 also logs each API request as
  // an `api-request-blob` row whose `message` repeats the prompt together with
  // every system reminder sent with it.
  if (!entry.message?.content || entry.isApiErrorMessage || (entry.type !== 'user' && entry.type !== 'assistant')) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return {
        text: content,
        role: 'assistant',
      };
    }

    const localCommand = parseClaudeLocalCommandPayload(content);
    if (localCommand) {
      const displayText = buildClaudeLocalCommandDisplayText(localCommand);
      return displayText
        ? {
            text: displayText,
            role: 'user',
          }
        : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiSequences(localCommandStdout).trim();
      return stdoutText
        ? {
            text: stdoutText,
            role: 'assistant',
          }
        : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return {
      text: content,
      role: rawRole,
    };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return {
      text,
      role: 'assistant',
    };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return {
    text,
    role: rawRole,
  };
}

function normalizeSearchableSessions(rows: SessionRepositoryRow[]): SearchableSessionRow[] {
  const normalizedRows: SearchableSessionRow[] = [];
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    const rawJsonlPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!rawJsonlPath) {
      continue;
    }

    const absoluteJsonlPath = path.resolve(rawJsonlPath);
    if (!fsSync.existsSync(absoluteJsonlPath)) {
      continue;
    }

    /**
     * Active session rows can still belong to an archived project because
     * project archiving intentionally preserves the underlying session data.
     * Global conversation search should follow the visible workspace model,
     * which means excluding any session whose owning project is archived.
     *
     * Cache the archive lookup per normalized project path so one search pass
     * does not re-query the same project row for every session in that folder.
     */
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }

      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    normalizedRows.push({
      ...row,
      provider,
      jsonl_path: absoluteJsonlPath,
    });
  }

  return normalizedRows;
}

function buildProjectBuckets(searchableSessions: SearchableSessionRow[]): ProjectBucket[] {
  const projectBuckets = new Map<string, ProjectBucket>();
  const projectMetadataCache = new Map<string, { projectId: string | null; projectDisplayName: string }>();

  for (const session of searchableSessions) {
    const key = makeProjectKey(session.project_path);
    if (!projectBuckets.has(key)) {
      if (!projectMetadataCache.has(key)) {
        if (key === UNKNOWN_PROJECT_KEY) {
          projectMetadataCache.set(key, {
            projectId: null,
            projectDisplayName: 'Unknown Project',
          });
        } else {
          const projectRow = projectsDb.getProjectPath(key);
          const customProjectName = typeof projectRow?.custom_project_name === 'string'
            ? projectRow.custom_project_name.trim()
            : '';
          const displayName = customProjectName || path.basename(key) || key;

          projectMetadataCache.set(key, {
            projectId: projectRow?.project_id ?? null,
            projectDisplayName: displayName,
          });
        }
      }

      const metadata = projectMetadataCache.get(key) as { projectId: string | null; projectDisplayName: string };
      projectBuckets.set(key, {
        key,
        projectId: metadata.projectId,
        projectName: key,
        projectDisplayName: metadata.projectDisplayName,
        sessions: [],
      });
    }

    const bucket = projectBuckets.get(key) as ProjectBucket;
    bucket.sessions.push(session);
  }

  const buckets = Array.from(projectBuckets.values());
  for (const bucket of buckets) {
    bucket.sessions.sort((left, right) => {
      const leftTs = new Date(left.updated_at || left.created_at || 0).getTime();
      const rightTs = new Date(right.updated_at || right.created_at || 0).getTime();
      return rightTs - leftTs;
    });
  }

  return buckets;
}

/**
 * Streams every transcript line that holds at least one prefilter string,
 * grouped by file, from one ripgrep pass over the known transcript paths.
 *
 * One pass that prints only those lines replaces a files-with-matches pass
 * per word followed by a full read of each matching file in Node: on WSL the
 * transcripts sit on /mnt/<drive>, where every byte read is a 9p round trip
 * and the old way read the same gigabyte several times.
 */
async function streamMatchingTranscriptLines(
  prefilterStrings: string[],
  filePaths: string[],
  onFileLines: (filePath: string, lines: string[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (prefilterStrings.length === 0 || filePaths.length === 0 || signal?.aborted) {
    return;
  }

  const args = [
    '--no-messages',
    '--ignore-case',
    '--fixed-strings',
    '--with-filename',
    '--null',
    '--no-line-number',
    '--max-columns',
    String(RIPGREP_MAX_LINE_LENGTH),
    ...prefilterStrings.flatMap((prefilterString) => ['-e', prefilterString]),
    '--',
    ...filePaths,
  ];

  await new Promise<void>((resolve, reject) => {
    const rg = spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let currentFilePath: string | null = null;
    let currentFileLines: string[] = [];

    const flushCurrentFile = () => {
      if (currentFilePath !== null && currentFileLines.length > 0) {
        onFileLines(currentFilePath, currentFileLines);
      }
      currentFilePath = null;
      currentFileLines = [];
    };

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };
    signal?.addEventListener('abort', abortListener, { once: true });

    // ripgrep prints all matches of one file together, so a change of path
    // marks the end of the previous file.
    const lineReader = readline.createInterface({ input: rg.stdout, crlfDelay: Infinity });
    lineReader.on('line', (outputLine) => {
      const separatorIndex = outputLine.indexOf('\0');
      if (separatorIndex === -1) {
        return;
      }
      const filePath = outputLine.slice(0, separatorIndex);
      const transcriptLine = outputLine.slice(separatorIndex + 1);
      if (filePath !== currentFilePath) {
        flushCurrentFile();
        currentFilePath = filePath;
      }
      if (!transcriptLine.startsWith(RIPGREP_OMITTED_LINE_PREFIX)) {
        currentFileLines.push(transcriptLine);
      }
    });

    rg.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      signal?.removeEventListener('abort', abortListener);
      if (aborted || signal?.aborted) {
        resolve();
        return;
      }
      reject(error);
    });

    // 'close' comes after stdout has ended, so every line has been read.
    rg.on('close', (exitCode) => {
      signal?.removeEventListener('abort', abortListener);
      if (aborted || signal?.aborted) {
        resolve();
        return;
      }
      flushCurrentFile();
      if (exitCode !== 0 && exitCode !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(exitCode)}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

async function scanTranscriptsForQuery(
  searchablePathEntries: SearchablePathEntry[],
  query: ConversationSearchQuery,
  onFileLines: (normalizedPath: string, lines: string[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const fileChunks = chunkArray(
    searchablePathEntries.map((entry) => entry.absolutePath),
    RIPGREP_FILE_CHUNK_SIZE,
  );

  let nextChunkIndex = 0;
  const workerCount = Math.min(RIPGREP_CHUNK_CONCURRENCY, fileChunks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextChunkIndex < fileChunks.length && !signal?.aborted) {
      const currentIndex = nextChunkIndex;
      nextChunkIndex += 1;
      await streamMatchingTranscriptLines(
        query.prefilterStrings,
        fileChunks[currentIndex],
        (filePath, lines) => onFileLines(normalizeComparablePath(filePath), lines),
        signal,
      );
    }
  });

  await Promise.all(workers);
}

/** A file can only hold a match when every prefilter string occurs in it somewhere. */
function linesContainEveryPrefilterString(query: ConversationSearchQuery, lines: string[]): boolean {
  const remaining = new Set(query.prefilterStrings);
  for (const line of lines) {
    const lowercasedLine = line.toLowerCase();
    for (const prefilterString of remaining) {
      if (lowercasedLine.includes(prefilterString)) {
        remaining.delete(prefilterString);
      }
    }
    if (remaining.size === 0) {
      return true;
    }
  }
  return false;
}

function keepBestSessionMatches(
  matches: RankedSessionMatch[],
  candidate: RankedSessionMatch,
): void {
  const weakestIndex = matches.length < MAX_MATCHES_PER_SESSION
    ? -1
    : matches.reduce((weakest, match, index) => (match.score < matches[weakest].score ? index : weakest), 0);
  if (weakestIndex === -1) {
    matches.push(candidate);
  } else if (candidate.score > matches[weakestIndex].score) {
    matches.splice(weakestIndex, 1);
    matches.push(candidate);
  }
}

/**
 * Turns the matching lines of one Claude transcript into per-session results.
 * Only lines that hold a query term reach this function, so session summaries
 * fall back to the matched messages when a session has no name.
 */
function collectClaudeSessionMatches(
  lines: string[],
  sessionsForFile: SearchableSessionRow[],
  query: ConversationSearchQuery,
): Map<string, SessionConversationResult> {
  // Transcript lines are tagged with the provider session id (e.g. Claude's own
  // conversation UUID), which is not necessarily the app-facing `session_id`.
  // Match and attribute by the provider id, but map results back to the
  // internal `session_id` the rest of the app uses to identify sessions.
  const providerToInternalId = new Map<string, string>();
  const customNameBySessionId = new Map<string, string | null>();
  for (const candidate of sessionsForFile) {
    const providerId = candidate.provider_session_id || candidate.session_id;
    providerToInternalId.set(providerId, candidate.session_id);
    customNameBySessionId.set(providerId, candidate.custom_name ?? null);
  }

  type ClaudeSessionSearchState = {
    matches: RankedSessionMatch[];
    matchedTermIndexes: Set<number>;
    fallbackUserText: string | null;
    fallbackAssistantText: string | null;
    resolvedSummary: string | null;
  };

  const sessionStateById = new Map<string, ClaudeSessionSearchState>();
  const getSessionState = (sessionId: string): ClaudeSessionSearchState => {
    let state = sessionStateById.get(sessionId);
    if (!state) {
      const titleMatch = matchQueryTerms(query, customNameBySessionId.get(sessionId) ?? '');
      state = {
        matches: [],
        matchedTermIndexes: new Set(titleMatch.matchedTermIndexes),
        fallbackUserText: null,
        fallbackAssistantText: null,
        resolvedSummary: null,
      };
      sessionStateById.set(sessionId, state);
    }
    return state;
  };

  for (const line of lines) {
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }

    const entrySessionId = entry.sessionId ? String(entry.sessionId) : null;
    if (!entrySessionId || !providerToInternalId.has(entrySessionId)) {
      continue;
    }

    const searchableMessage = extractClaudeSearchableMessage(entry);
    if (!searchableMessage) {
      continue;
    }

    const { text, role } = searchableMessage;
    const termMatch = matchQueryTerms(query, text);
    if (termMatch.matchedTermIndexes.length === 0) {
      continue;
    }

    const state = getSessionState(entrySessionId);
    // A compact summary describes the state a resumed session continues from.
    if (entry.isCompactSummary === true) {
      state.resolvedSummary = text;
    }
    if (role === 'user') {
      state.fallbackUserText ??= text;
    } else {
      state.fallbackAssistantText ??= text;
    }
    for (const termIndex of termMatch.matchedTermIndexes) {
      state.matchedTermIndexes.add(termIndex);
    }

    const { snippet, highlights } = buildQuerySnippet(query, text, termMatch.firstMatchIndex);
    keepBestSessionMatches(state.matches, {
      score: termMatch.matchedTermIndexes.length,
      role,
      snippet,
      highlights,
      timestamp: entry.timestamp ? String(entry.timestamp) : null,
      provider: 'claude',
      messageUuid: entry.uuid ? String(entry.uuid) : null,
    });
  }

  const fileResults = new Map<string, SessionConversationResult>();
  for (const [sessionId, state] of sessionStateById.entries()) {
    // Every term has to occur in the session, though not in one message.
    if (state.matches.length === 0 || state.matchedTermIndexes.size < query.terms.length) {
      continue;
    }

    const internalSessionId = providerToInternalId.get(sessionId) ?? sessionId;
    fileResults.set(internalSessionId, {
      sessionId: internalSessionId,
      provider: 'claude',
      sessionSummary: toSummaryText(
        customNameBySessionId.get(sessionId) ?? null,
        state.resolvedSummary || state.fallbackUserText || state.fallbackAssistantText,
        'New Session',
      ),
      matches: state.matches
        .sort((left, right) => right.score - left.score)
        .map(({ score: _score, ...match }) => match),
    });
  }

  return fileResults;
}

/**
 * Searches session titles and provider transcripts for the provider search
 * service and its route-level integration tests.
 */
export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
  onTitleResults: ((results: SessionTitleSearchResult[]) => void) | null = null,
): Promise<{
  results: ProjectConversationResult[];
  titleResults: SessionTitleSearchResult[];
  totalMatches: number;
  query: string;
}> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const parsedQuery = parseConversationSearchQuery(safeQuery);

  if (parsedQuery.terms.length === 0) {
    return { results: [], titleResults: [], totalMatches: 0, query: safeQuery };
  }

  const isAborted = () => signal?.aborted === true;
  if (isAborted()) {
    return { results: [], titleResults: [], totalMatches: 0, query: safeQuery };
  }

  const activeSessions = sessionsDb.getAllSessions();
  const titleResults = findSessionTitleResults(activeSessions, parsedQuery, safeLimit);
  onTitleResults?.(titleResults);

  const searchableSessions = normalizeSearchableSessions(activeSessions);
  if (searchableSessions.length === 0) {
    return { results: [], titleResults, totalMatches: 0, query: safeQuery };
  }

  const sessionsByPathKey = new Map<string, SearchableSessionRow[]>();
  const searchablePathEntries: SearchablePathEntry[] = [];

  for (const session of searchableSessions) {
    const normalizedPath = normalizeComparablePath(session.jsonl_path);
    if (!normalizedPath) {
      continue;
    }

    if (!sessionsByPathKey.has(normalizedPath)) {
      sessionsByPathKey.set(normalizedPath, []);
      searchablePathEntries.push({
        normalizedPath,
        absolutePath: session.jsonl_path,
      });
    }

    const pathSessions = sessionsByPathKey.get(normalizedPath) as SearchableSessionRow[];
    pathSessions.push(session);
  }

  const resultsByFileKey = new Map<string, Map<string, SessionConversationResult>>();
  await scanTranscriptsForQuery(
    searchablePathEntries,
    parsedQuery,
    (fileKey, lines) => {
      const sessionsForFile = (sessionsByPathKey.get(fileKey) ?? [])
        .filter((session) => session.provider === 'claude');
      if (sessionsForFile.length === 0 || !linesContainEveryPrefilterString(parsedQuery, lines)) {
        return;
      }
      resultsByFileKey.set(fileKey, collectClaudeSessionMatches(lines, sessionsForFile, parsedQuery));
    },
    signal ?? undefined,
  );
  if (isAborted()) {
    return { results: [], titleResults, totalMatches: 0, query: safeQuery };
  }

  const projectBuckets = buildProjectBuckets(searchableSessions);
  const totalProjects = projectBuckets.length;
  const results: ProjectConversationResult[] = [];
  let totalMatches = 0;
  let scannedProjects = 0;

  for (const bucket of projectBuckets) {
    if (totalMatches >= safeLimit) {
      break;
    }

    const projectResult: ProjectConversationResult = {
      projectId: bucket.projectId,
      projectName: bucket.projectName,
      projectDisplayName: bucket.projectDisplayName,
      sessions: [],
    };

    for (const session of bucket.sessions) {
      if (totalMatches >= safeLimit) {
        break;
      }
      const fileKey = normalizeComparablePath(session.jsonl_path);
      const sessionResult = resultsByFileKey.get(fileKey)?.get(session.session_id);
      if (!sessionResult) {
        continue;
      }
      const remainingMatches = safeLimit - totalMatches;
      const limitedResult = sessionResult.matches.length > remainingMatches
        ? { ...sessionResult, matches: sessionResult.matches.slice(0, remainingMatches) }
        : sessionResult;
      projectResult.sessions.push(limitedResult);
      totalMatches += limitedResult.matches.length;
    }

    scannedProjects += 1;
    if (projectResult.sessions.length > 0) {
      results.push(projectResult);
      onProjectResult?.({
        projectResult,
        totalMatches,
        scannedProjects,
        totalProjects,
      });
    } else if (onProjectResult && scannedProjects % 10 === 0) {
      onProjectResult({
        projectResult: null,
        totalMatches,
        scannedProjects,
        totalProjects,
      });
    }
  }

  return {
    results,
    titleResults,
    totalMatches,
    query: safeQuery,
  };
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<void> {
    await searchConversations(
      input.query,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
      input.onTitleResults ?? null,
    );
  },
};
