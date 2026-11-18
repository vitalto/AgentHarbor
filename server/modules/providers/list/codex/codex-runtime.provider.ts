import { setTimeout as delay } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { getCodexModelCatalog } from '@/modules/providers/list/codex/codex-models.provider.js';
import { findCodexRollout, readCodexRollout } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { readCodexUsage } from '@/modules/providers/list/codex/codex-usage.js';
import {
  applyCodexSelection, createTranscriptTail, ensureCodexWindow, getCodexCliConfig, readCodexScreen,
  stageAttachmentForClaude, tmuxService, typeCodexInput, waitForCodexComposer,
} from '@/modules/tmux/index.js';
import {
  appendFilesInputTag, createCompleteMessage, createNormalizedMessage, normalizeAttachmentDescriptors, readObjectRecord,
} from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

type Destination = { paneId: string; title: string };
type Turn = { ready: Promise<Destination | null>; input: Promise<unknown>; startup: AbortController; submitted: boolean; interrupted: boolean };
const turns = new Map<string, Turn>();

async function resolveRollout(appId: string, nativeId: string, searchArchive: boolean) {
  const session = sessionsDb.getSessionById(appId);
  if (session?.provider_session_id !== nativeId) throw new Error('The Codex session changed before its transcript was opened.');
  if (session.jsonl_path) return session.jsonl_path;
  const file = await findCodexRollout(nativeId, searchArchive);
  if (file && session.project_path) {
    // The first reply can finish before the filesystem watcher has indexed the new rollout.
    sessionsDb.createSession(nativeId, 'codex', session.project_path, undefined, undefined, undefined, file);
  }
  return file;
}

async function typeMessage(destination: Destination, command: string, options: AnyRecord, signal?: AbortSignal) {
  const config = getCodexCliConfig().pathConfig;
  const stage = (input: unknown) => Promise.all(normalizeAttachmentDescriptors(input).map(async (file) => ({
    ...file, path: await stageAttachmentForClaude(file.path, config),
  })));
  const [files, images] = await Promise.all([stage(options.files), stage(options.images)]);
  await typeCodexInput(destination.paneId, appendFilesInputTag(command, files), images.map((file) => file.path), destination.title, signal);
}

function withTurnInput(sessionId: string, action: (destination: Destination, turn: Turn) => Promise<boolean>) {
  const turn = turns.get(sessionId);
  if (!turn) return Promise.resolve(false);
  const result = turn.input.then(async () => {
    const destination = await turn.ready;
    if (!destination || turn.interrupted || turns.get(sessionId) !== turn) return false;
    return action(destination, turn);
  });
  turn.input = result.catch(() => false);
  return result;
}

/** Web and CLI follow-ups go into the same composer, serialized so concurrent pastes cannot mix. */
export function steerCodexTurn(sessionId: string, command: string, options: AnyRecord) {
  return withTurnInput(sessionId, async (destination) => {
    await typeMessage(destination, command, options);
    return true;
  });
}

async function interruptCodexTurn(sessionId: string) {
  const pending = turns.get(sessionId);
  if (!pending) return false;
  if (!pending.submitted) {
    pending.startup.abort();
    if (!await pending.ready) return true;
  }
  return withTurnInput(sessionId, async ({ paneId, title }, turn) => {
    const screen = await readCodexScreen(paneId);
    if (screen.title !== title) return false;
    await tmuxService.sendKeys(paneId, ['Escape']);
    turn.interrupted = true;
    if (turns.get(sessionId) === turn) turns.delete(sessionId);
    return true;
  });
}

/** The registered Codex provider runs turns from web sockets and the ah CLI through the pane's TUI. */
export async function runCodexTmuxTurn(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
  const appId = options.sessionId;
  if (!appId || turns.has(appId)) throw new Error('A Codex turn requires an available session.');
  const emit = (message: unknown) => writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message));
  const note = (kind: 'error' | 'status', fields: AnyRecord) => emit(createNormalizedMessage({ sessionId: appId, provider: 'codex', kind, ...fields }));
  const notification = { userId: writer.userId ?? null, provider: 'codex', sessionId: appId, sessionName: options.sessionSummary };
  let resolveReady!: (destination: Destination | null) => void;
  const turn: Turn = { ready: new Promise((resolve) => { resolveReady = resolve; }), input: Promise.resolve(),
    startup: new AbortController(), submitted: false, interrupted: false };
  turns.set(appId, turn);
  try {
    const { pane, providerSessionId: previousId, legacyThreadId } = await ensureCodexWindow(appId);
    const { screen, providerSessionId } = await waitForCodexComposer(appId, pane, turn.startup.signal, legacyThreadId);
    writer.setSessionId?.(providerSessionId);
    const destination = { paneId: pane.paneId, title: screen.title };
    const session = sessionsDb.getSessionById(appId);
    if (screen.activity !== 'working') {
      const model = await context.resolveResumeModel(appId, options.model) || 'default';
      await applyCodexSelection(pane, destination.title, model, options.effort || session?.effort || 'default', async () => {
        const defaults = await getCodexModelCatalog();
        if (model === 'default') return defaults;
        const catalog = await context.getProviderModels();
        return { effort: catalog.OPTIONS.find((entry) => entry.value === model)?.effort?.default };
      });
    }

    const rollout = await resolveRollout(appId, providerSessionId, Boolean(previousId));
    let tail = rollout ? createTranscriptTail(rollout) : null;
    // Baseline before Enter: a short answer can already be on disk when paste/submit returns.
    await tail?.poll();
    await typeMessage(destination, command, options, turn.startup.signal);
    turn.submitted = true;
    resolveReady(destination);
    let aborted = false;
    let failure: string | null = null;
    async function* appendedRows() {
      let noActivitySince = Date.now();
      let nextFileLookup = 0;
      const localCommand = command.trimStart().startsWith('/');
      let sawTurn = false;
      let turnId: string | undefined;
      let waiting = false;
      for (;;) {
        if (turn.interrupted) return;
        if (!tail && Date.now() >= nextFileLookup) {
          const file = await resolveRollout(appId, providerSessionId, false);
          if (file) tail = createTranscriptTail(file, 0);
          nextFileLookup = Date.now() + 1000;
        }
        const batch = await tail?.poll();
        if (batch?.reset) throw new Error('The Codex transcript changed while reading this turn. Reopen the conversation.');
        let completed = false;
        for (const raw of batch?.rows ?? []) {
          const entry = readObjectRecord(raw);
          if (!entry) continue;
          noActivitySince = Date.now();
          yield entry;
          const payload = entry.payload;
          if (entry.type !== 'event_msg' || !payload) continue;
          if (payload.type === 'task_started' || payload.type === 'turn_started') {
            turnId = payload.turn_id;
            sawTurn = true;
            completed = false;
          }
          if (turnId && payload.turn_id && payload.turn_id !== turnId) continue;
          const usage = readCodexUsage(entry);
          if (usage) note('status', { text: 'token_budget', tokenBudget: usage });
          if (payload.type === 'error') failure = payload.message || 'Codex reported an error.';
          if ((sawTurn || screen.activity === 'working') && ['task_complete', 'turn_complete', 'turn_aborted'].includes(payload.type)) {
            aborted = payload.type === 'turn_aborted';
            completed = true;
          }
        }
        if (completed) return;
        const current = await readCodexScreen(pane.paneId);
        if (current.title !== destination.title && current.composer) throw new Error('The terminal switched to a different Codex session.');
        const isWaiting = current.activity === 'waiting';
        if (waiting !== isWaiting) {
          waiting = isWaiting;
          note('status', { text: waiting ? 'Codex is waiting for your response in Terminal.' : 'Working', canInterrupt: true });
        }
        if (localCommand && !sawTurn && current.activity !== 'working' && (current.empty || isWaiting)
          && Date.now() - noActivitySince > 1500) return;
        if (current.activity === 'working' || isWaiting) noActivitySince = Date.now();
        if (Date.now() - noActivitySince > 20_000) throw new Error(failure || 'Codex returned no turn completion. Check the terminal and its transcript.');
        await delay(250);
      }
    }
    await readCodexRollout(appendedRows(), undefined, (row) => {
      for (const message of context.normalizeMessage(row, appId)) emit(message);
    });
    if (turn.interrupted) return;
    if (failure) throw new Error(failure);
    emit(createCompleteMessage({ provider: 'codex', sessionId: appId, actualSessionId: providerSessionId, exitCode: 0, aborted }));
    notifyRunStopped({ ...notification, stopReason: aborted ? 'interrupted' : 'completed' });
  } catch (error) {
    if (!turn.submitted && turn.startup.signal.aborted) {
      emit(createCompleteMessage({ provider: 'codex', sessionId: appId, exitCode: 0, aborted: true }));
      return;
    }
    note('error', { content: error instanceof Error ? error.message : String(error) });
    emit(createCompleteMessage({ provider: 'codex', sessionId: appId, exitCode: 1 }));
    notifyRunFailed({ ...notification, error });
  } finally {
    resolveReady(null);
    if (turns.get(appId) === turn) turns.delete(appId);
  }
}

/** Provider registry adapter for the interactive Codex CLI. */
export const codexRuntime = { run: runCodexTmuxTurn, abort: interruptCodexTurn };
