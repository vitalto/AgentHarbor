import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getCodexCliConfig, toLocalPath } from '@/modules/tmux/index.js';
import {
  buildLookupMap,
  getCodexHome,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readLastTranscriptEntryTime,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  createdAt?: string;
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
  private readonly scannedFiles = new Map<string, { size: number; mtime: number; nativeId?: string; title?: string }>();

  async synchronize(): Promise<number> {
    const [files, names] = await Promise.all([
      findFilesRecursivelyCreatedAfter(path.join(this.codexHome, 'sessions'), '.jsonl', null),
      this.readNames(),
    ]);
    let processed = 0;
    for (const file of files) {
      if (await this.indexFile(file, names)) processed++;
    }
    const present = new Set(files);
    for (const previous of this.scannedFiles.keys()) {
      if (!present.has(previous)) this.scannedFiles.delete(previous);
    }
    return processed;
  }

  private readNames(): Promise<Map<string, string>> {
    return buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) return null;
    return this.indexFile(filePath, await this.readNames(), true);
  }

  private async indexFile(filePath: string, names: Map<string, string>, force = false): Promise<string | null> {
    const file = await stat(filePath).catch(() => null);
    if (!file) return null;

    const previous = this.scannedFiles.get(filePath);
    if (!force && previous && previous.size === file.size && previous.mtime === file.mtimeMs
      && previous.title === (previous.nativeId ? names.get(previous.nativeId) : undefined)) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath, names);
    const title = parsed ? names.get(parsed.sessionId) : undefined;
    if (!parsed) {
      this.scannedFiles.set(filePath, { size: file.size, mtime: file.mtimeMs });
      return null;
    }

    const lastEntry = await readLastTranscriptEntryTime(filePath);
    const appId = sessionsDb.createSession(
      parsed.sessionId, this.provider, parsed.projectPath, parsed.sessionName,
      parsed.createdAt ?? (file.birthtimeMs > 0 ? file.birthtime : file.mtime).toISOString(),
      lastEntry?.toISOString() ?? file.mtime.toISOString(), filePath, Boolean(title),
    );
    this.scannedFiles.set(filePath, { size: file.size, mtime: file.mtimeMs, nativeId: parsed.sessionId, title });
    return appId;
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (data.type !== 'session_meta' || !sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        createdAt: typeof data.timestamp === 'string' ? data.timestamp : undefined,
        projectPath: toLocalPath(projectPath, getCodexCliConfig().pathConfig),
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

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
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
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
