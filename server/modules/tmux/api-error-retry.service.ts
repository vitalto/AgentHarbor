import { Resolver } from 'node:dns/promises';
import fsp from 'node:fs/promises';

import { appConfigDb, getConnection, sessionsDb } from '@/modules/database/index.js';
import { getAgentConfig } from '@/modules/tmux/agent-config.js';
import { typeIntoAgent } from '@/modules/tmux/agent-windows.service.js';
import { readClaudeProcesses, type ClaudeProcess } from '@/modules/tmux/claude-status.js';
import { getCodexCliConfig } from '@/modules/tmux/codex-cli.js';
import { readCodexRetryFailure } from '@/modules/tmux/codex-retry-failure.js';
import { listCodexLiveThreads, sendCodexRuntimePrompt } from '@/modules/tmux/codex-windows.service.js';
import { paneRegistry, type PaneSession } from '@/modules/tmux/pane-registry.service.js';
import { tmuxService } from '@/modules/tmux/tmux.service.js';
import { readInputBox } from '@/modules/tmux/tui-prompt.js';
import { runWindowsPowerShell } from '@/modules/tmux/windows-powershell.js';

const SWEEP_INTERVAL_MS = 30_000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** An error older than this is history, not something to resume, e.g. a window reopened days later. */
const MAX_ERROR_AGE_MS = 6 * 60 * 60_000;
const DELAY_GROWTH = 3;
const NETWORK_CHECK_CACHE_MS = 30_000;
const dnsProbeHosts = { claude: 'api.anthropic.com', codex: 'chatgpt.com' };
const MAX_ERROR_TEXT_CHARS = 160;
const CODEX_RETRY_CLAIMS = 'codex.api_error_retry_claims';
const MAX_CODEX_RETRY_CLAIMS = 512;

export const API_ERROR_RETRY_MARKER = '[AgentHarbor] API error retry';

/**
 * Claude's own labels for a request that died on the way: the network or the
 * API server failed, not the request itself. `network_edge_blocked` (HTTP 403
 * "the network this request came from isn't allowed") comes with a brief
 * internet outage here, when traffic leaves through the wrong route for a moment. Everything else (rate and usage
 * limits, which Claude resumes itself; auth; safeguards; local out of memory)
 * would fail the same way again.
 */
const TRANSIENT_ERRORS = new Set(['server_error']);
const TRANSIENT_API_ERRORS = new Set(['connection_failed', 'stream_idle_timeout', 'computer_slept', 'network_edge_blocked']);

export type ApiErrorRetrySettings = { attempts: number; delayMinutes: number };

export type ApiErrorRetryPlan =
  | { kind: 'none' }
  | { kind: 'retry'; attempt: number; dueAt: number; errorUuid: string; errorText: string }
  | { kind: 'exhausted'; attempts: number; errorText: string };

type TranscriptRow = {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  error?: unknown;
  apiError?: unknown;
  message?: { content?: unknown };
};

function parseRows(transcriptTail: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of transcriptTail.split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      // The tail starts mid-line, and the last line may still be being written.
    }
  }
  return rows;
}

function isConversationRow(row: TranscriptRow): boolean {
  return (row.type === 'user' || row.type === 'assistant') && row.isSidechain !== true;
}

export function isTransientApiError(row: TranscriptRow): boolean {
  return row.type === 'assistant'
    && row.isApiErrorMessage === true
    && (TRANSIENT_ERRORS.has(String(row.error)) || TRANSIENT_API_ERRORS.has(String(row.apiError)));
}

function contentParts(row: TranscriptRow): Array<{ type?: unknown; text?: unknown }> {
  const content = row.message?.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function textOf(row: TranscriptRow): string {
  return contentParts(row)
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ');
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').replaceAll('"', "'").trim();
  return collapsed.length > MAX_ERROR_TEXT_CHARS ? `${collapsed.slice(0, MAX_ERROR_TEXT_CHARS - 3)}...` : collapsed;
}

/**
 * Retries already sent in a row for the error at the end: continuation
 * prompts with no finished tool call between them. A tool result means the
 * last retry got the agent working again, so the next failure starts afresh;
 * a prompt from the user ends the count as well.
 */
function countRetriesInARow(rows: TranscriptRow[], errorIndex: number): number {
  let retries = 0;
  for (let index = errorIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!isConversationRow(row) || row.type !== 'user' || row.isMeta === true) {
      continue;
    }
    if (contentParts(row).some((part) => part?.type === 'tool_result')) {
      break;
    }
    if (!textOf(row).trimStart().startsWith(API_ERROR_RETRY_MARKER)) {
      break;
    }
    retries += 1;
  }
  return retries;
}

/**
 * What to do about a turn that ended on an API error, from the end of the
 * transcript: retry attempt N once its delay (delay x 1, 3, 9...) has passed
 * since the error, give up after `attempts` retries in a row, or nothing when
 * the last row is anything but a transient error.
 */
export function planApiErrorRetry(transcriptTail: string, settings: ApiErrorRetrySettings, now: number): ApiErrorRetryPlan {
  if (settings.attempts <= 0) {
    return { kind: 'none' };
  }
  const rows = parseRows(transcriptTail);
  let errorIndex = rows.length - 1;
  while (errorIndex >= 0 && !isConversationRow(rows[errorIndex])) {
    errorIndex -= 1;
  }
  const error = rows[errorIndex];
  if (!error || !isTransientApiError(error) || typeof error.uuid !== 'string') {
    return { kind: 'none' };
  }
  const errorAt = Date.parse(String(error.timestamp));
  return planRetry(settings, now, errorAt, error.uuid, oneLine(textOf(error)), countRetriesInARow(rows, errorIndex));
}

function planRetry(settings: ApiErrorRetrySettings, now: number, errorAt: number, errorUuid: string,
  errorText: string, retriesSent: number): ApiErrorRetryPlan {
  if (settings.attempts <= 0 || !Number.isFinite(errorAt) || now - errorAt > MAX_ERROR_AGE_MS) {
    return { kind: 'none' };
  }
  if (retriesSent >= settings.attempts) {
    return { kind: 'exhausted', attempts: retriesSent, errorText };
  }
  const delayMs = settings.delayMinutes * 60_000 * DELAY_GROWTH ** retriesSent;
  return { kind: 'retry', attempt: retriesSent + 1, dueAt: errorAt + delayMs, errorUuid, errorText };
}

/** The tmux retry sweep applies the shared retry count and delay to terminal Codex rollout errors. */
export function planCodexApiErrorRetry(tail: string, settings: ApiErrorRetrySettings, now: number): ApiErrorRetryPlan {
  const failed = readCodexRetryFailure(tail, API_ERROR_RETRY_MARKER);
  if (!failed) return { kind: 'none' };
  return planRetry(settings, now, failed.errorAt, failed.errorUuid, failed.errorText, failed.retriesSent);
}

export function formatApiErrorRetry(plan: Extract<ApiErrorRetryPlan, { kind: 'retry' }>, attempts: number): string {
  return `${API_ERROR_RETRY_MARKER} ${plan.attempt}/${attempts}: your last response ended with "${plan.errorText}". `
    + 'The network is up again; continue the task from where you stopped.';
}

export function readApiErrorRetrySettings(): ApiErrorRetrySettings {
  const config = getAgentConfig();
  return { attempts: config.apiErrorRetryAttempts, delayMinutes: config.apiErrorRetryDelayMinutes };
}

export async function readTranscriptEnd(transcriptPath: string, bytes: number = TRANSCRIPT_TAIL_BYTES): Promise<string> {
  const handle = await fsp.open(transcriptPath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Use Windows connectivity status and DNS so checking a provider never consumes an API request. */
async function checkNetwork(provider: keyof typeof dnsProbeHosts): Promise<boolean> {
  const windows = provider === 'claude' ? getAgentConfig().windowsClaude : getCodexCliConfig().pathConfig.windowsClaude;
  if (windows) {
    const internetProfiles = await runWindowsPowerShell(
      "@(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq 'Internet' -or $_.IPv6Connectivity -eq 'Internet' }).Count",
      20_000,
    );
    // An empty answer means PowerShell itself failed; that says nothing about the network.
    if (internetProfiles.trim() === '0') {
      return false;
    }
  }
  try {
    const addresses = await new Resolver({ timeout: 5000, tries: 2 }).resolve4(dnsProbeHosts[provider]);
    return addresses.length > 0;
  } catch {
    return false;
  }
}

const networkChecks = new Map<keyof typeof dnsProbeHosts, { at: number; online: Promise<boolean> }>();

function networkLooksUp(now: number, provider: keyof typeof dnsProbeHosts): Promise<boolean> {
  let networkCheck = networkChecks.get(provider);
  if (!networkCheck || now - networkCheck.at >= NETWORK_CHECK_CACHE_MS) {
    networkCheck = { at: now, online: checkNetwork(provider) };
    networkChecks.set(provider, networkCheck);
  }
  return networkCheck.online;
}

/** Sessions whose last turn ended on a transient API error that will still be retried; the idle reaper keeps their windows. */
let sessionsAwaitingRetry = new Set<string>();
let codexAwaitingRetry = new Set<string>();
/** The error each session was last retried for, so a slow transcript write never gets a second prompt. */
const retriedErrors = new Map<string, string>();

export function isAwaitingApiErrorRetry(providerSessionId: string): boolean {
  return sessionsAwaitingRetry.has(providerSessionId) || codexAwaitingRetry.has(providerSessionId);
}

function newestProcessOf(processes: ClaudeProcess[], providerSessionId: string): ClaudeProcess | null {
  return processes
    .filter((claude) => claude.providerSessionId === providerSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** Types only into an empty input box, so a draft someone left in the terminal is never sent along. */
async function sendRetry(pane: PaneSession, text: string): Promise<boolean> {
  const box = readInputBox(await tmuxService.capturePane(pane.pane.paneId));
  if (!box || box.text !== '' || box.pasting) {
    return false;
  }
  await typeIntoAgent(pane.pane.paneId, text);
  return true;
}

function readCodexClaims(now: number): Record<string, number> {
  const saved: Record<string, number> = JSON.parse(appConfigDb.get(CODEX_RETRY_CLAIMS) ?? '{}');
  return Object.fromEntries(Object.entries(saved).filter(([, expires]) => expires >= now));
}

function updateCodexClaims(now: number, update: (claims: Record<string, number>) => boolean): boolean {
  return getConnection().transaction(() => {
    const claims = readCodexClaims(now);
    if (!update(claims)) return false;
    appConfigDb.set(CODEX_RETRY_CLAIMS, JSON.stringify(claims));
    return true;
  }).immediate();
}

async function sweepCodexRetries(settings: ApiErrorRetrySettings, now: number, deps: typeof codexRetryRuntime): Promise<number> {
  const awaiting = new Set<string>();
  let sent = 0;
  for (const { pane, providerSessionId, activity } of await deps.listThreads()) {
    if (!pane || activity !== 'idle') continue;
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (row?.provider !== 'codex' || !row.jsonl_path) continue;
    const rollout = row.jsonl_path;
    const plan = planCodexApiErrorRetry(await readTranscriptEnd(rollout).catch(() => ''), settings, now);
    if (plan.kind !== 'retry') continue;
    const key = `${providerSessionId}/${plan.errorUuid}`;
    if (Object.hasOwn(readCodexClaims(now), key)) continue;
    awaiting.add(providerSessionId);
    if (now < plan.dueAt || !await deps.online(now, 'codex')) continue;
    let claimedUntil: number | null = null;
    try {
      const delivered = await deps.send(providerSessionId, pane, formatApiErrorRetry(plan, settings.attempts), async () => {
        const tail = await readTranscriptEnd(rollout);
        const current = Date.now();
        const fresh = planCodexApiErrorRetry(tail, readApiErrorRetrySettings(), current);
        if (fresh.kind !== 'retry' || fresh.errorUuid !== plan.errorUuid || fresh.attempt !== plan.attempt || fresh.dueAt > current) return false;
        // Persist before touching the terminal. A crash after Enter leaves delivery ambiguous across restarts.
        return updateCodexClaims(current, (claims) => {
          if (Object.hasOwn(claims, key) || Object.keys(claims).length >= MAX_CODEX_RETRY_CLAIMS) return false;
          claimedUntil = current + MAX_ERROR_AGE_MS;
          claims[key] = claimedUntil;
          return true;
        });
      });
      if (delivered) {
        awaiting.delete(providerSessionId);
        sent++;
        console.log(`[AgentHarbor] API error retry ${plan.attempt}/${settings.attempts} sent to ${pane.windowName}`);
      } else if (claimedUntil !== null) {
        // A changed composer yields a definite skip before paste. An exception may mean Enter already reached Codex.
        updateCodexClaims(Date.now(), (claims) => {
          if (claims[key] !== claimedUntil) return false;
          delete claims[key];
          return true;
        });
      }
    } catch (error) {
      console.error(`[AgentHarbor] could not send an API error retry to ${pane.windowName}`, error);
    }
  }
  codexAwaitingRetry = awaiting;
  return sent;
}

async function sweepClaudeRetries(settings: ApiErrorRetrySettings, now: number): Promise<number> {
  const [panes, processes] = await Promise.all([paneRegistry.refresh(), readClaudeProcesses()]);
  const awaiting = new Set<string>();
  let retried = 0;
  for (const pane of panes) {
    if (!pane.registered || !pane.providerSessionId || !pane.transcriptPath) {
      continue;
    }
    const claude = newestProcessOf(processes, pane.providerSessionId);
    if (!claude) {
      continue;
    }
    const plan = planApiErrorRetry(await readTranscriptEnd(pane.transcriptPath).catch(() => ''), settings, now);
    if (plan.kind !== 'retry') {
      retriedErrors.delete(pane.providerSessionId);
      continue;
    }
    awaiting.add(pane.providerSessionId);
    if (claude.activity !== 'idle' || now < plan.dueAt || retriedErrors.get(pane.providerSessionId) === plan.errorUuid) {
      continue;
    }
    if (!(await networkLooksUp(now, 'claude'))) {
      continue;
    }
    const delivered = await sendRetry(pane, formatApiErrorRetry(plan, settings.attempts)).catch((error) => {
      console.error(`[AgentHarbor] could not send an API error retry to ${pane.pane.windowName}`, error);
      return false;
    });
    if (delivered) {
      retriedErrors.set(pane.providerSessionId, plan.errorUuid);
      retried += 1;
      console.log(`[AgentHarbor] API error retry ${plan.attempt}/${settings.attempts} sent to ${pane.pane.windowName}: ${plan.errorText}`);
    }
  }
  sessionsAwaitingRetry = awaiting;
  return retried;
}

const codexRetryRuntime = { listThreads: listCodexLiveThreads, online: networkLooksUp, send: sendCodexRuntimePrompt };

/** The tmux scheduler checks both providers independently for failed turns awaiting continuation. */
export async function sweepApiErrorRetries(now: number = Date.now(), codex = codexRetryRuntime): Promise<number> {
  const settings = readApiErrorRetrySettings();
  if (settings.attempts <= 0) {
    sessionsAwaitingRetry.clear();
    codexAwaitingRetry.clear();
    return 0;
  }
  const providers = await Promise.allSettled([sweepClaudeRetries(settings, now), sweepCodexRetries(settings, now, codex)]);
  let sent = 0;
  for (const result of providers) {
    if (result.status === 'fulfilled') sent += result.value;
    else console.error('[AgentHarbor] API error retry sweep failed', result.reason);
  }
  return sent;
}

export function startApiErrorRetries(): void {
  let sweeping = false;
  const sweep = () => {
    if (sweeping) {
      return;
    }
    sweeping = true;
    void sweepApiErrorRetries()
      .catch((error) => console.error('[AgentHarbor] API error retry sweep failed', error))
      .finally(() => {
        sweeping = false;
      });
  };
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
