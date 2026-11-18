import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getCodexCliConfig, toLocalPath } from '@/modules/tmux/index.js';
import { isArchivedCodexRollout, readCodexTranscriptEntries, retainSessionTranscript } from '@/shared/index.js';
import {
  buildLookupMap,
  getCodexHome,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readLastTranscriptEntryTime,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  createdAt?: string;
  lastEntry?: Date;
  sessionName?: string;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = getCodexHome();

  // A Windows writer can append through WSL while the file mtime stays at its
  // opening time. Size catches live turns and an empty map backfills a new home.
  private readonly scannedFiles = new Map<string, { size: bigint; mtime: bigint; inode: bigint; nativeId?: string; title?: string }>();

  async synchronize(): Promise<number> {
    const [activeFiles, archivedFiles, names] = await Promise.all([
      findFilesRecursivelyCreatedAfter(path.join(this.codexHome, 'sessions'), '', null),
      findFilesRecursivelyCreatedAfter(path.join(this.codexHome, 'archived_sessions'), '', null),
      this.readNames(),
    ]);
    const files = [...archivedFiles, ...activeFiles].filter((file) => /\.jsonl(?:\.zst)?$/.test(file));
    let processed = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        if (await this.indexFile(file, names)) processed++;
      } catch (error) {
        failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const present = new Set(files);
    for (const previous of this.scannedFiles.keys()) {
      if (!present.has(previous)) this.scannedFiles.delete(previous);
    }
    if (failures.length) throw new Error(`Failed to synchronize ${failures.length} Codex rollout(s): ${failures[0]}`);
    return processed;
  }

  private readNames(): Promise<Map<string, string>> {
    return buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!/\.jsonl(?:\.zst)?$/.test(filePath)) return null;
    return this.indexFile(filePath, await this.readNames(), true);
  }

  private async indexFile(filePath: string, names: Map<string, string>, force = false): Promise<string | null> {
    const file = await stat(filePath, { bigint: true }).catch(() => null);
    if (!file) return null;

    const previous = this.scannedFiles.get(filePath);
    if (!force && previous && previous.size === file.size && previous.mtime === file.mtimeNs && previous.inode === file.ino
      && previous.title === (previous.nativeId ? names.get(previous.nativeId) : undefined)) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath, names);
    const title = parsed ? names.get(parsed.sessionId) : undefined;
    if (!parsed) {
      this.scannedFiles.set(filePath, { size: file.size, mtime: file.mtimeNs, inode: file.ino });
      return null;
    }

    const previousPath = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)?.jsonl_path;
    const lastEntry = parsed.lastEntry ?? (filePath.endsWith('.zst') ? null : await readLastTranscriptEntryTime(filePath));
    const appId = sessionsDb.createSession(
      parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName,
      parsed.createdAt ?? (file.birthtimeMs > 0 ? file.birthtime : file.mtime).toISOString(),
      lastEntry?.toISOString() ?? file.mtime.toISOString(), filePath, Boolean(title),
    );
    if (isArchivedCodexRollout(filePath)) {
      sessionsDb.updateSessionIsArchived(appId, true);
    } else if (previousPath && isArchivedCodexRollout(previousPath)) {
      sessionsDb.updateSessionIsArchived(appId, false);
    }
    await retainSessionTranscript(filePath);
    this.scannedFiles.set(filePath, { size: file.size, mtime: file.mtimeNs, inode: file.ino, nativeId: parsed.sessionId, title });
    return appId;
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    let parsed: ParsedSession | null = null;
    let compressedTitle: string | undefined;
    try {
      for await (const data of readCodexTranscriptEntries(filePath)) {
        const payload = data.payload;
        if (!parsed && data.type === 'session_meta' && typeof payload?.id === 'string' && typeof payload.cwd === 'string') {
          if (this.isSubagentSessionMeta(payload)) return null;
          parsed = { sessionId: payload.id, createdAt: data.timestamp, projectPath: toLocalPath(payload.cwd, getCodexCliConfig().pathConfig) };
          if (!filePath.endsWith('.zst')) break;
        }
        if (parsed && typeof data.timestamp === 'string' && Number.isFinite(Date.parse(data.timestamp))) {
          parsed.lastEntry = new Date(data.timestamp);
        }
        if (data.type === 'event_msg' && payload?.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
          compressedTitle = payload.last_agent_message;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!parsed) return null;

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (!nameMap.has(parsed.sessionId) && existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = filePath.endsWith('.zst') ? compressedTitle : await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
