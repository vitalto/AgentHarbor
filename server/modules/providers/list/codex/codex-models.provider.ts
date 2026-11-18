import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import TOML from '@iarna/toml';

import { sessionsDb } from '@/modules/database/index.js';
import { getCodexCliConfig } from '@/modules/tmux/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const run = promisify(execFile);
const defaultOption = { value: 'default', label: 'Codex CLI default', description: 'Use the model configured in Codex.' };

/** Minimal provider picker when the CLI has no discoverable models. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  PARTIAL: true,
  OPTIONS: [defaultOption],
  DEFAULT: defaultOption.value,
};

function decodeCodexCatalog(raw: string, configuredModel?: string) {
  const models = readObjectRecord(JSON.parse(raw))?.models;
  if (!Array.isArray(models)) throw new Error('Invalid Codex model catalog.');

  const options = new Map<string, ProviderModelOption>();
  for (const row of models) {
    const id = readOptionalString(row?.slug);
    if (!id || id === defaultOption.value || options.has(id)) continue;
    if (row.visibility && row.visibility !== 'list') continue;

    const values: NonNullable<ProviderModelOption['effort']>['values'] = [];
    for (const level of Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : []) {
      const value = readOptionalString(level?.effort);
      if (value && !values.some((entry) => entry.value === value)) {
        values.push({ value, description: readOptionalString(level.description) });
      }
    }
    const defaultEffort = readOptionalString(row.default_reasoning_level);
    options.set(id, {
      value: id,
      label: readOptionalString(row.display_name) ?? id,
      description: readOptionalString(row.description),
      effort: values.length ? {
        default: values.some((level) => level.value === defaultEffort) ? defaultEffort : undefined,
        values,
      } : undefined,
    });
  }
  if (!options.size) throw new Error('Empty Codex model catalog.');
  const defaultId = configuredModel ?? [...models]
    .filter((row) => options.has(row?.slug))
    .sort((first, second) => (first.priority ?? Infinity) - (second.priority ?? Infinity))[0]?.slug;
  const effort = options.get(defaultId)?.effort;
  const catalog: ProviderModelsDefinition = {
    DEFAULT: defaultOption.value,
    OPTIONS: [{ ...defaultOption, ...(effort ? { effort } : {}) }, ...options.values()],
  };
  return { catalog, model: defaultId as string | undefined };
}

/** Used by the provider catalog tests to verify native model and effort choices. */
export function parseCodexModelCatalog(raw: string, configuredModel?: string): ProviderModelsDefinition {
  return decodeCodexCatalog(raw, configuredModel).catalog;
}

async function readCodexModelCatalog({ home, executable, env }: ReturnType<typeof getCodexCliConfig>) {
  const runCatalogCommand = async (args: string[]) => (await run(executable, ['debug', 'models', ...args], {
    timeout: 8000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env,
  })).stdout;

  let configuredModel: string | undefined;
  let configuredEffort: string | undefined;
  try {
    const config = TOML.parse(await readFile(path.join(home, 'config.toml'), 'utf8'));
    const profile = readOptionalString(config.profile);
    const profiles = readObjectRecord(config.profiles);
    configuredModel = (profile && readOptionalString(profiles?.[profile]?.model)) || readOptionalString(config.model);
    configuredEffort = (profile && readOptionalString(profiles?.[profile]?.model_reasoning_effort)) || readOptionalString(config.model_reasoning_effort);
  } catch {
    // Codex can run with just its built-in configuration.
  }

  for (const load of [
    () => readFile(path.join(home, 'models_cache.json'), 'utf8'),
    () => runCatalogCommand(['--bundled']),
  ]) {
    try {
      const { catalog, model } = decodeCodexCatalog(await load(), configuredModel);
      return { catalog, model, effort: configuredEffort ?? catalog.OPTIONS[0].effort?.default };
    } catch {
      // Older CLIs and offline installations may only have one of these sources.
    }
  }
  return { catalog: CODEX_PREDEFINED_MODELS, model: configuredModel, effort: configuredEffort };
}

async function readReplyFromOffset(file: string, start: number): Promise<ProviderCurrentActiveModel | null> {
  const stream = createReadStream(file, { encoding: 'utf8', start });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let turn: ProviderCurrentActiveModel | null = null;
  let lastReply: ProviderCurrentActiveModel | null = null;
  try {
    for await (const line of lines) {
      let event;
      try {
        event = readObjectRecord(JSON.parse(line));
      } catch {
        continue;
      }
      const payload = readObjectRecord(event?.payload);
      if (!payload) continue;
      if (event?.type === 'event_msg' && payload.type === 'task_started') turn = null;
      if (event?.type === 'turn_context') {
        const model = readOptionalString(payload.model);
        const effort = readOptionalString(payload.effort)
          ?? readOptionalString(payload.reasoning_effort)
          ?? readOptionalString(payload.collaboration_mode?.settings?.reasoning_effort);
        turn = model ? { model, ...(effort ? { effort } : {}) } : null;
      }
      const assistantMessage = event?.type === 'response_item' && payload.type === 'message'
        && payload.role === 'assistant' && payload.phase !== 'commentary'
        && Array.isArray(payload.content) && payload.content.some((item) => readOptionalString(item?.text));
      const completedReply = event?.type === 'event_msg' && payload.type === 'task_complete'
        && readOptionalString(payload.last_agent_message);
      const finalAgentMessage = event?.type === 'event_msg' && payload.type === 'agent_message'
        && payload.phase === 'final_answer' && readOptionalString(payload.message);
      if (assistantMessage || completedReply || finalAgentMessage) lastReply = turn;
    }
    return lastReply;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Resolves the chat model badge from the turn that produced the last recorded reply. */
export async function readCodexLastReplySelection(file: string): Promise<ProviderCurrentActiveModel | null> {
  const { size } = await stat(file);
  const start = Math.max(0, size - 256 * 1024);
  if (start > 0) {
    const recentReply = await readReplyFromOffset(file, start);
    if (recentReply) return recentReply;
  }
  // Large tool output or an unfinished turn can put the last reply outside the tail.
  return readReplyFromOffset(file, 0);
}

let cachedCatalog: { key: string; expiresAt: number; result: ReturnType<typeof readCodexModelCatalog> } | undefined;

/** The model picker and TUI driver resolve the session's default from the same offline CLI catalog. */
export function getCodexModelCatalog() {
  const cli = getCodexCliConfig();
  const key = JSON.stringify([cli.home, cli.executable]);
  if (!cachedCatalog || cachedCatalog.key !== key || Date.now() >= cachedCatalog.expiresAt) {
    cachedCatalog = { key, expiresAt: Date.now() + 60_000, result: readCodexModelCatalog(cli) };
  }
  return cachedCatalog.result;
}

/** Supplies the provider registry with native Codex model choices and per-session reply metadata. */
export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return (await getCodexModelCatalog()).catalog;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId) {
      const session = sessionsDb.getSessionById(sessionId);
      if (session?.provider === 'codex' && session.jsonl_path) {
        try {
          const reply = await readCodexLastReplySelection(session.jsonl_path);
          if (reply) return reply;
        } catch {
          // A roll-out can be removed or relocated between synchronization scans.
        }
      }
    }
    return { model: defaultOption.value };
  }
}
