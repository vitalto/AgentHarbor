import { sessionsDb } from '@/modules/database/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { connectCodexDaemon, ensureCodexWindow, toNativeCodexPath, waitForCodexPrompt } from '@/modules/tmux/index.js';
import { appendFilesInputTag, createCompleteMessage, createNormalizedMessage, normalizeAttachmentDescriptors, normalizeImageDescriptors } from '@/shared/index.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

const turns = new Map<string, () => Promise<boolean>>();

export function interruptCodexTurn(sessionId: string) {
  return turns.get(sessionId)?.() ?? false;
}

function normalizeItem(item: AnyRecord): AnyRecord | null {
  const base = { type: 'item', itemId: item.id, uuid: item.id, status: item.status === 'inProgress' ? 'in_progress' : item.status };
  switch (item.type) {
    case 'agentMessage': return { ...base, itemType: 'agent_message', message: { role: 'assistant', content: item.text } };
    case 'reasoning': return { ...base, itemType: 'reasoning', message: { role: 'assistant', content: (item.summary?.length ? item.summary : item.content)?.join('\n'), isReasoning: true } };
    case 'commandExecution': return { ...base, itemType: 'command_execution', command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode };
    case 'fileChange': return { ...base, itemType: 'file_change', changes: item.changes?.map((change: AnyRecord) => ({ ...change, kind: change.kind?.type ?? change.kind })) };
    case 'mcpToolCall': return { ...item, ...base, itemType: 'mcp_tool_call' };
    case 'webSearch': return { ...item, ...base, itemType: 'web_search' };
    default: return null;
  }
}

const runtimeDependencies = {
  connect: connectCodexDaemon, window: ensureCodexWindow, waitForPrompt: waitForCodexPrompt,
  effort: (id: string) => sessionsDb.getSessionById(id)?.effort,
  stopped: notifyRunStopped, failed: notifyRunFailed,
};

export async function runCodexTmuxTurn(
  command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext,
  dependencies = runtimeDependencies,
) {
  const appId: string = options.sessionId;
  if (!appId) throw new Error('A Codex turn requires an AgentHarbor session id.');
  const emit = (message: unknown) => writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message));
  const note = (kind: 'error' | 'status' | 'stream_delta', fields: AnyRecord) =>
    emit(createNormalizedMessage({ sessionId: appId, provider: 'codex', kind, ...fields }));
  const notification = { userId: writer.userId ?? null, provider: 'codex', sessionId: options.sessionId, sessionName: options.sessionSummary };
  let client: Awaited<ReturnType<typeof connectCodexDaemon>> | undefined;
  let abortRequested = false;
  try {
    const { providerSessionId: threadId, pane } = await dependencies.window(appId, false);
    await dependencies.waitForPrompt(pane);
    writer.setSessionId?.(threadId);
    client = await dependencies.connect();
    const { thread, sandbox, approvalPolicy } = await client.request('thread/resume', { threadId, excludeTurns: true });
    if (thread?.status?.type === 'active') throw new Error('Codex already has a turn in progress in this session.');
    const model = await context.resolveResumeModel(appId, options.model);
    const catalog = await context.getProviderModels();
    const selected = catalog.OPTIONS.find((entry) => entry.value === (model === 'default' ? catalog.DEFAULT : model));
    const requestedEffort = options.effort ?? dependencies.effort(appId);
    const effort = requestedEffort === 'default' ? selected?.effort?.default
      : selected?.effort?.values?.some((entry) => entry.value === requestedEffort) ? requestedEffort : undefined;
    const prompt = appendFilesInputTag(command, normalizeAttachmentDescriptors(options.files)
      .map((file) => ({ ...file, path: toNativeCodexPath(file.path) })));
    const input = [...(prompt.trim() ? [{ type: 'text', text: prompt, text_elements: [] }] : []),
      ...normalizeImageDescriptors(options.images).map((image) => ({ type: 'localImage', path: toNativeCodexPath(image.path) }))];
    const commands = new Map<string, AnyRecord>();
    const publishItem = (item: AnyRecord) => {
      const raw = normalizeItem(item);
      if (raw) for (const message of context.normalizeMessage(raw, appId)) emit(message);
    };
    let settle!: (turn: AnyRecord) => void;
    let fail!: (error: Error) => void;
    const completion = new Promise<AnyRecord>((resolve, reject) => { settle = resolve; fail = reject; });
    // The proxy can disconnect before turn/start has returned its response.
    void completion.catch(() => {});
    let turnId: string | undefined;
    let waitingForInput = false;
    const early: Array<[string, AnyRecord]> = [];
    const onEvent = (method: string, params: AnyRecord) => {
      if (params.threadId !== threadId) return;
      if (!turnId) { early.push([method, params]); return; }
      if (method === 'thread/status/changed' && params.status?.type === 'active') {
        const waiting = Boolean(params.status.activeFlags?.length);
        if (waiting !== waitingForInput) {
          waitingForInput = waiting;
          note('status', { text: waiting ? 'Codex is waiting for your response in Terminal.' : 'Working', canInterrupt: true });
        }
      }
      if ((params.turnId ?? params.turn?.id) !== turnId) return;
      if (method === 'turn/completed') { settle(params.turn); return; }
      if (method === 'item/agentMessage/delta') note('stream_delta', { content: params.delta });
      if (method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage;
        if (usage?.last) note('status', { text: 'token_budget', tokenBudget: { used: usage.last.totalTokens, total: usage.modelContextWindow, inputTokens: usage.last.inputTokens, outputTokens: usage.last.outputTokens } });
      }
      if (method === 'item/started' && params.item?.type === 'commandExecution') commands.set(params.item.id, params.item);
      if (method === 'item/commandExecution/outputDelta') {
        const item = commands.get(params.itemId);
        if (item) { item.aggregatedOutput = (item.aggregatedOutput || '') + params.delta; publishItem(item); }
      }
      if (method === 'item/completed' || method === 'item/started') {
        if (params.item) publishItem(params.item);
        if (method === 'item/completed') commands.delete(params.item?.id);
      }
    };
    client.observe(onEvent, fail);
    const sandboxPolicy = sandbox?.type === 'readOnly' || sandbox?.type === 'workspaceWrite' ? sandbox
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    const result = await client.request('turn/start', { threadId, input, sandboxPolicy,
      approvalPolicy: approvalPolicy ?? 'on-request',
      ...(model && model !== 'default' ? { model } : model === 'default' && catalog.DEFAULT !== 'default' ? { model: catalog.DEFAULT } : {}),
      ...(effort ? { effort } : {}),
    });
    turnId = result.turn?.id;
    if (!turnId) throw new Error('Codex did not return a turn id.');
    const connection = client;
    turns.set(appId, async () => {
      abortRequested = true;
      try { await connection.request('turn/interrupt', { threadId, turnId }); return true; }
      catch { abortRequested = false; return false; }
    });
    for (const [method, params] of early) onEvent(method, params);
    const turn = await completion;
    if (turn.status === 'failed') throw new Error(turn.error?.message || 'Codex turn failed.');
    if (!abortRequested) {
      emit(createCompleteMessage({ provider: 'codex', sessionId: appId, actualSessionId: threadId, exitCode: 0, aborted: turn.status === 'interrupted' }));
      dependencies.stopped({ ...notification, stopReason: turn.status });
    }
  } catch (error) {
    note('error', { content: error instanceof Error ? error.message : String(error) });
    emit(createCompleteMessage({ provider: 'codex', sessionId: appId, exitCode: 1 }));
    dependencies.failed({ ...notification, error });
  } finally {
    turns.delete(appId);
    client?.close();
  }
}

export const codexRuntime = { run: runCodexTmuxTurn, abort: interruptCodexTurn };
