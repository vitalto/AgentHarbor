import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { javascriptLanguage } from '@codemirror/lang-javascript';

import { readCodexTranscriptEntries } from '@/shared/index.js';
import { readCodexUsage } from '@/modules/providers/list/codex/codex-usage.js';
import { CodexToolCallTimeline } from '@/modules/providers/list/codex/codex-tool-call-timeline.js';
import { sessionsDb } from '@/modules/database/index.js';
import { parseFilesInputTag, toImageAttachments } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  MemoryCitation,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getCodexHome,
  readObjectRecord,
  sliceTailPage,
  truncateSubagentActivity,
} from '@/shared/utils.js';

const PROVIDER = 'codex';

/**
 * How far up the `~/.codex/sessions/<year>/<month>/<day>` tree a subagent
 * rollout is searched for when it is not next to its parent. Spawned agents
 * are written seconds after the parent, so one directory level up (the month)
 * already covers a run that crosses midnight.
 */
const SUBAGENT_LOOKUP_PARENT_LEVELS = 2;

/**
 * Upper bound on how much of a subagent's timeline is sent to the client. A
 * long-running agent can record hundreds of tool calls, and the transcript only
 * ever shows them behind a collapsed header, so shipping the whole history on
 * every load costs far more than it shows.
 */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

type CodexHistoryResult = {
  messages: AnyRecord[];
  total?: number;
  hasMore?: boolean;
  offset?: number;
  limit?: number | null;
  tokenUsage?: unknown;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function createCodexRowIdReader() {
  const occurrences = new Map<string, number>();
  return (entry: AnyRecord): string => {
    const id = readNonEmptyString(entry.payload?.id)
      ?? readNonEmptyString(entry.payload?.event_id)
      ?? readNonEmptyString(entry.id);
    if (id) return id;

    // A live turn starts partway through the rollout. Only earlier copies of this exact legacy row can affect its ID.
    const fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('base64url');
    const ordinal = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, ordinal + 1);
    return `codex-row:${fingerprint}:${ordinal}`;
  };
}

/**
 * Follows which turn a Codex rollout is inside as its rows stream past.
 *
 * Codex writes no per-row id вЂ” every line is `{timestamp, type, payload}` and
 * the `user_message` event that carries a prompt has no identity of its own вЂ”
 * so a turn id is the only durable address a user message has. Turns are
 * bracketed by rows that do carry `turn_id`: `task_started` opens one,
 * `turn_context` restates it, `task_complete` closes it, and the prompt is
 * written between them.
 *
 * `thread_rolled_back` retires the last N turns in place: the rows stay in the
 * file. Only prompts in the active conversation retain their turn anchors.
 */
function createCodexTurnTracker() {
  /** Turn ids still part of the conversation, oldest first. */
  const liveTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  const rolledBackTurnIds = new Set<string>();
  let currentTurnId: string | undefined;

  return {
    /** Feeds one rollout row in. */
    observe(entryType: unknown, payload: AnyRecord): void {
      if (entryType === 'event_msg' && payload.type === 'thread_rolled_back') {
        const retiredTurns = Number(payload.num_turns);
        for (let retired = 0; retired < retiredTurns && liveTurnIds.length > 0; retired++) {
          rolledBackTurnIds.add(liveTurnIds.pop() as string);
        }
        currentTurnId = undefined;
        return;
      }

      const turnId = readNonEmptyString(payload.turn_id);
      if (!turnId) {
        return;
      }
      currentTurnId = turnId;
      if (!seenTurnIds.has(turnId)) {
        seenTurnIds.add(turnId);
        liveTurnIds.push(turnId);
      }
    },
    /** The turn the rows being read belong to, or undefined outside one. */
    getCurrentTurnId(): string | undefined {
      return currentTurnId;
    },
    getLiveTurnIds(): string[] {
      return liveTurnIds;
    },
    isRolledBack(turnId: string): boolean {
      return rolledBackTurnIds.has(turnId);
    },
  };
}

/**
 * Reads the image attachments Codex records on `user_message` events.
 * Turns sent with `local_image` input items land in `local_images` as file
 * paths (verified against real rollout JSONL); the `images` array can carry
 * base64 data URLs, which are passed through as inline `data` attachments so
 * the UI can preview them without a file lookup.
 *
 * Exported for tests.
 */
export function extractCodexUserImages(
  payload: AnyRecord | null | undefined,
): Array<{ path?: string; data?: string }> | undefined {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
  ];

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

function withoutCodexImagePlaceholders(text: string, elements: unknown): string {
  if (!Array.isArray(elements) || !elements.length) return text;

  // Codex addresses placeholders in UTF-8 bytes. The same label can also occur in the user's own prose.
  const bytes = Buffer.from(text);
  const ranges = elements.flatMap(element => {
    const { start, end } = element?.byte_range ?? {};
    const placeholder = element?.placeholder;
    if (typeof placeholder !== 'string' || !/^\[Image #[1-9]\d*\]$/.test(placeholder)
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length
      || bytes.toString('utf8', start, end) !== placeholder) return [];
    return [{ start, end }];
  }).sort((a, b) => a.start - b.start);

  let caption = '';
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start < cursor) continue;
    caption += bytes.toString('utf8', cursor, start);
    // The composer inserts a separating space after each attached image, outside its marked range.
    cursor = bytes[end] === 0x20 ? end + 1 : end;
  }
  return cursor ? caption + bytes.toString('utf8', cursor) : text;
}

function extractCodexTextContent(content: unknown, hasImages = false): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return hasImages ? withoutCodexImagePlaceholders(record.text, record.text_elements) : record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Conversation search uses the same visible caption as the live and saved transcripts. */
export function extractCodexSearchableMessage(entry: AnyRecord): { role: 'user' | 'assistant'; text: string } | null {
  const payload = readObjectRecord(entry.payload);
  if (!payload) return null;
  if (entry.type === 'event_msg') {
    const prompt = readCodexUserPrompt(payload);
    if (prompt) return { role: 'user', text: parseFilesInputTag(prompt.content).text };
  }
  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    return { role: 'assistant', text: readCodexMemoryCitations(extractCodexTextContent(payload.content)).text };
  }
  return null;
}

/** Reads image inputs from a typed UserMessage item. */
function extractCodexTypedUserImages(
  content: unknown,
): Array<{ path?: string; data?: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const rawEntry of content) {
    const entry = readObjectRecord(rawEntry);
    if (!entry) {
      continue;
    }

    const value = entry.type === 'local_image'
      ? readNonEmptyString(entry.path)
      : entry.type === 'image'
        ? readNonEmptyString(entry.image_url)
        : undefined;
    if (!value) {
      continue;
    }
    if (value.startsWith('data:')) {
      attachments.push({ data: value });
    } else {
      attachments.push(...toImageAttachments([value]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

function readCodexUserPrompt(payload: AnyRecord) {
  const item = payload.type === 'item_completed' && payload.item?.type === 'UserMessage' ? payload.item : null;
  const legacy = payload.type === 'user_message' && (!payload.kind || payload.kind === 'plain') && typeof payload.message === 'string';
  if (!item && !legacy) return null;

  const images = item ? extractCodexTypedUserImages(item.content) : extractCodexUserImages(payload);
  const content = item
    ? extractCodexTextContent(item.content, Boolean(images))
    : withoutCodexImagePlaceholders(payload.message, images && payload.text_elements);
  return content.trim() || images ? { content, images, id: readNonEmptyString(item?.id) } : null;
}

/**
 * Reads the markdown out of Codex's `<proposed_plan>` envelope.
 *
 * Codex delivers a plan as a wrapped assistant message while Claude delivers
 * one as an `ExitPlanMode` call. Recognizing the envelope here lets both end up
 * on the same plan card instead of one provider showing a card and the other
 * showing prose with a stray tag in it. The closing tag is optional because a
 * streamed plan exposes the opening tag first.
 *
 * Exported for tests.
 */
export function readCodexProposedPlan(text: string): string | null {
  const openingTag = /^\s*<proposed_plan>[ \t]*(?:\r?\n)?/i;
  if (!openingTag.test(text)) {
    return null;
  }

  const body = text
    .replace(openingTag, '')
    .replace(/(?:\r?\n)?[ \t]*<\/proposed_plan>\s*$/i, '')
    .trim();

  return body || null;
}

/**
 * The block Codex appends to a reply that leaned on its memory files. It is
 * always the last thing in the message and is meant for programmatic parsing,
 * so it reads as raw XML when left in the prose.
 */
const CODEX_MEMORY_CITATION_BLOCK = /<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>\s*$/i;

/**
 * Lifts Codex's memory citations out of an assistant reply.
 *
 * The block names the memory files and line ranges the answer drew on, which is
 * worth showing вЂ” but as a footnote under the reply, not as markup inside it.
 * The trailing `<rollout_ids>` list is dropped: those are handles to earlier
 * rollouts that the transcript view has no way to open.
 *
 * Exported for tests.
 */
export function readCodexMemoryCitations(text: string): { text: string; memoryCitations?: MemoryCitation[] } {
  const block = CODEX_MEMORY_CITATION_BLOCK.exec(text);
  if (!block) {
    return { text };
  }

  const entries = /<citation_entries>([\s\S]*?)<\/citation_entries>/i.exec(block[1])?.[1] ?? '';
  const memoryCitations: MemoryCitation[] = [];
  for (const line of entries.split('\n')) {
    const entry = line.trim();
    if (!entry) {
      continue;
    }

    const noteMarker = entry.indexOf('|note=');
    const source = (noteMarker === -1 ? entry : entry.slice(0, noteMarker)).trim();
    if (!source) {
      continue;
    }

    const note = noteMarker === -1
      ? ''
      : entry.slice(noteMarker + '|note='.length).trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    memoryCitations.push(note ? { source, note } : { source });
  }

  const prose = text.slice(0, block.index).trimEnd();
  return memoryCitations.length > 0 ? { text: prose, memoryCitations } : { text: prose };
}

function extractCodexToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (!Array.isArray(output)) {
    return output == null ? '' : JSON.stringify(output);
  }

  return output
    .map((item) => {
      const record = readObjectRecord(item);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

// в”Ђв”Ђв”Ђ Codex "code mode" exec scripts в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Newer Codex builds (and every Sol-family model) stop calling shell/patch
// tools directly. Instead they emit one `exec` custom tool call whose input is
// a small JavaScript program that awaits `tools.<name>({...})`. Persisting that
// program verbatim is what makes the transcript read as raw machinery, so it is
// parsed back into the operations it performs.

type CodexExecOperation =
  | { kind: 'shell'; command: string; justification?: string }
  | { kind: 'unresolved-shell' }
  | { kind: 'stdin'; chars: string }
  | { kind: 'patch'; patch?: string }
  | { kind: 'search'; queries: string[] }
  | { kind: 'plan'; todos: CodexPlanTodo[] };

/** One step of a checklist, in the shape the shared todo renderer consumes. */
type CodexPlanTodo = { content: string; status: string };

/**
 * Decodes one JavaScript string literal (single, double or backtick quoted).
 *
 * Template literals with `${}` interpolation are returned with the expression
 * text intact вЂ” the transcript has no bindings to evaluate, and showing the
 * raw template is still far more readable than the surrounding program.
 */
function decodeJavaScriptStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }

  return literal
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([\\'`])/g, '$1');
}

function readCodexExecCalls(source: string) {
  const tree = javascriptLanguage.parser.parse(source);
  const calls: { toolName: string; argumentSource: string; patch?: string }[] = [];
  const constants = new Map<string, { value: string; from: number; to: number } | undefined>();

  function staticString(node: typeof tree.topNode | null | undefined) {
    if (node?.name === 'String' || (node?.name === 'TemplateString' && !node.getChild('Interpolation'))) {
      return decodeJavaScriptStringLiteral(source.slice(node.from, node.to));
    }
  }

  tree.iterate({ enter(ref) {
    if (ref.name === 'VariableDefinition') {
      const definition = ref.node;
      const name = source.slice(ref.from, ref.to);
      const declaration = definition.parent;
      const value = declaration?.firstChild?.name === 'const' && definition.nextSibling?.name === 'Equals'
        ? staticString(definition.nextSibling.nextSibling) : undefined;
      let scope = declaration;
      while (scope?.parent && scope.name !== 'Block') scope = scope.parent;
      // A shadowed or computed binding cannot supply a reliable filename.
      constants.set(name, value !== undefined && scope && !constants.has(name) ? { value, from: scope.from, to: scope.to } : undefined);
      return;
    }
    if (ref.name !== 'CallExpression') return;
    const node = ref.node;
    const target = node.firstChild;
    const args = node.getChild('ArgList');
    if (target?.name !== 'MemberExpression' || !args) return;
    const toolName = /^tools\s*\.\s*([\w$]+)$/.exec(source.slice(target.from, target.to))?.[1];
    if (!toolName) return;
    const argumentSource = source.slice(args.from + 1, args.to - 1);
    let patch: string | undefined;
    if (toolName === 'apply_patch') {
      const binding = constants.get(argumentSource.trim());
      patch = binding && binding.from <= node.from && node.to <= binding.to
        ? binding.value : staticString(args.firstChild?.nextSibling);
    }
    calls.push({ toolName, argumentSource, patch });
  } });
  return calls;
}

/** Reads `key: "value"` / `"key": "value"` out of an object-literal source. */
function readStringProperty(objectSource: string, key: string): string | undefined {
  const pattern = new RegExp(
    `(?:["']${key}["']|\\b${key})\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)(?=\\s*(?:[,}]|$))`,
    's',
  );
  const match = pattern.exec(objectSource);
  return match ? decodeJavaScriptStringLiteral(match[1]) : undefined;
}

/** Reads every `q: "..."` entry out of a `web__run` search-query array. */
function readSearchQueries(objectSource: string): string[] {
  const pattern = /(?:["']q["']|\bq)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;
  return Array.from(objectSource.matchAll(pattern), (match) => decodeJavaScriptStringLiteral(match[1]));
}

/**
 * Reads the steps of an `update_plan` call made from an exec script.
 *
 * The script writes its argument as a JavaScript object literal with unquoted
 * keys, so it is not JSON вЂ” each `{step, status}` entry is matched directly.
 */
function readPlanSteps(objectSource: string): CodexPlanTodo[] {
  const todos: CodexPlanTodo[] = [];
  for (const entry of objectSource.matchAll(/\{([^{}]*)\}/g)) {
    const content = readStringProperty(entry[1], 'step') ?? readStringProperty(entry[1], 'content');
    if (content) {
      todos.push({ content, status: readStringProperty(entry[1], 'status') ?? 'pending' });
    }
  }

  return todos;
}

/**
 * Recovers commands a script keeps in a local array and maps over, which is how
 * Codex batches several shell calls:
 *   `const cmds = ["a", "b"]; await Promise.all(cmds.map(command => tools.shell_command({ command })))`
 * The call site then passes `{ command }` shorthand, so there is no literal to
 * read at the call itself.
 */
function readMappedCommandCandidates(source: string): string[] {
  const commands: string[] = [];
  const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g;
  const stringPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;

  for (const arrayMatch of source.matchAll(arrayPattern)) {
    // Tuple/object batches can contain labels, paths and options alongside the command.
    if (/[^\s,]/.test(arrayMatch[2].replace(stringPattern, ''))) continue;
    if (!new RegExp(`\\b${arrayMatch[1]}\\.map\\s*\\(`).test(source)) {
      continue;
    }
    for (const stringMatch of arrayMatch[2].matchAll(stringPattern)) {
      commands.push(decodeJavaScriptStringLiteral(stringMatch[1]));
    }
  }

  return commands;
}

/**
 * Turns one Codex `exec` script into the operations it performs, in source
 * order. An empty result means the script did nothing recognizable and the
 * caller should fall back to showing it as code.
 *
 * Exported for tests.
 */
export function parseCodexExecScript(input: unknown): CodexExecOperation[] {
  const source = typeof input === 'string' ? input : String(input ?? '');
  if (!source.includes('tools')) {
    return [];
  }

  const operations: CodexExecOperation[] = [];
  /** Filled in lazily, and only once, for shorthand-argument shell calls. */
  let mappedCommands: string[] | null = null;

  for (const { toolName, argumentSource, patch } of readCodexExecCalls(source)) {
    switch (toolName) {
      case 'shell_command':
      case 'exec_command': {
        const command = readStringProperty(argumentSource, 'command')
          ?? readStringProperty(argumentSource, 'cmd');
        if (command) {
          operations.push({
            kind: 'shell',
            command,
            justification: readStringProperty(argumentSource, 'justification'),
          });
          break;
        }

        if (mappedCommands === null) {
          mappedCommands = readMappedCommandCandidates(source);
          for (const mappedCommand of mappedCommands) {
            operations.push({ kind: 'shell', command: mappedCommand });
          }
        }
        if (!mappedCommands.length) operations.push({ kind: 'unresolved-shell' });
        break;
      }
      case 'write_stdin': {
        operations.push({ kind: 'stdin', chars: readStringProperty(argumentSource, 'chars') ?? '' });
        break;
      }
      case 'apply_patch': {
        operations.push({ kind: 'patch', patch });
        break;
      }
      case 'web__run':
      case 'web_search': {
        const queries = readSearchQueries(argumentSource);
        if (queries.length > 0) {
          operations.push({ kind: 'search', queries });
        }
        break;
      }
      case 'update_plan': {
        const todos = readPlanSteps(argumentSource);
        if (todos.length > 0) {
          operations.push({ kind: 'plan', todos });
        }
        break;
      }
      default:
        break;
    }
  }

  return operations;
}

// в”Ђв”Ђв”Ђ Codex shell output в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

type CodexShellOutput = {
  output: string;
  /** Set when the command has exited; `undefined` while it is still running. */
  exitCode?: number;
  /** Present while the command runs in the background under this cell id. */
  runningCellId?: string;
  truncated: boolean;
};

/**
 * Strips the two nested envelopes Codex wraps shell output in.
 *
 * The outer one reports on the sandbox *script* (`Script completed`, its wall
 * time, and `Output:`); the inner one reports on the *command* (`Exit code`,
 * its own wall time, an optional line count). Neither is useful in a chat
 * transcript, but the exit code decides whether the row is shown as failed, so
 * it is lifted out before the text is discarded.
 *
 * Exported for tests.
 */
export function cleanCodexShellOutput(rawOutput: string): CodexShellOutput {
  let output = rawOutput;
  let exitCode: number | undefined;
  let runningCellId: string | undefined;
  let truncated = false;

  const runningMatch = /^Script running with cell ID\s+(\S+)[^\n]*\n?/i.exec(output);
  if (runningMatch) {
    runningCellId = runningMatch[1];
    output = output.slice(runningMatch[0].length);
  } else {
    output = output.replace(/^Script (?:completed|failed)[^\n]*\n?/i, '');
  }

  output = output.replace(/^Wall time[^\n]*\n?/i, '');
  output = output.replace(/^Output:\s*\n?/i, '');
  output = output.replace(/^Script error:\s*\n?/i, '');

  const truncationMatch = /^Warning: truncated output[^\n]*\n(?:Total output lines:[^\n]*\n)?\n?/i.exec(output);
  if (truncationMatch) {
    truncated = true;
    output = output.slice(truncationMatch[0].length);
    output = output.replace(/^Script error:\s*\n?/i, '');
  }

  const exitCodeMatch = /^Exit code:\s*(-?\d+)[^\n]*\n?/i.exec(output);
  if (exitCodeMatch) {
    exitCode = Number.parseInt(exitCodeMatch[1], 10);
    output = output.slice(exitCodeMatch[0].length);
    output = output.replace(/^Wall time:[^\n]*\n?/i, '');
    output = output.replace(/^Total output lines:[^\n]*\n?/i, '');
    output = output.replace(/^Output:\s*\n?/i, '');
  }

  return { output, exitCode, runningCellId, truncated };
}

/**
 * `write_stdin` answers with a JSON envelope rather than plain text. Only its
 * `output` and `exit_code` matter to a reader.
 */
function readCodexStdinOutput(rawOutput: string): CodexShellOutput | null {
  const trimmed = rawOutput.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as AnyRecord;
    if (typeof parsed.output !== 'string') {
      return null;
    }
    return {
      output: parsed.output,
      exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : undefined,
      truncated: false,
    };
  } catch {
    return null;
  }
}

// в”Ђв”Ђв”Ђ Unified patches в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

type CodexFileChange = {
  filePath: string;
  /** `add` and `delete` are rendered as a whole-file write/removal. */
  changeType: 'add' | 'update' | 'delete';
  oldText: string;
  newText: string;
};

/**
 * Rebuilds the before/after text of one unified diff.
 *
 * Only the hunks are available вЂ” never the whole file вЂ” so the reconstruction
 * keeps context lines in both sides and drops hunk headers. Feeding that pair
 * to the frontend's line differ reproduces exactly the additions, removals and
 * surrounding context the patch described, which is what Claude's `Edit` rows
 * already show.
 *
 * Exported for tests.
 */
export function unifiedDiffToTexts(unifiedDiff: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\ No newline')) {
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    const contextLine = line.startsWith(' ') ? line.slice(1) : line;
    oldLines.push(contextLine);
    newLines.push(contextLine);
  }

  // A unified diff ends with a newline, which would otherwise reconstruct as a
  // phantom trailing blank line on both sides.
  if (oldLines[oldLines.length - 1] === '' && newLines[newLines.length - 1] === '') {
    oldLines.pop();
    newLines.pop();
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/**
 * Splits a `*** Begin Patch` body into one change per file.
 *
 * Exported for tests.
 */
export function parseCodexPatch(patch: string): CodexFileChange[] {
  const changes: CodexFileChange[] = [];
  const lines = patch.split('\n');
  let current: { filePath: string; changeType: CodexFileChange['changeType']; body: string[] } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const { oldText, newText } = unifiedDiffToTexts(current.body.join('\n'));
    changes.push({
      filePath: current.filePath,
      changeType: current.changeType,
      oldText: current.changeType === 'add' ? '' : oldText,
      newText: current.changeType === 'delete' ? '' : newText,
    });
    current = null;
  };

  for (const line of lines) {
    const fileHeader = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (fileHeader) {
      flush();
      const changeType = fileHeader[1].toLowerCase() as CodexFileChange['changeType'];
      current = { filePath: fileHeader[2].trim(), changeType, body: [] };
      continue;
    }

    if (line.startsWith('*** ')) {
      // `*** Begin Patch`, `*** End Patch`, `*** Move to:` вЂ” never diff content.
      continue;
    }

    current?.body.push(line);
  }

  flush();
  return changes;
}

function readPatchApplyChanges(changes: unknown): CodexFileChange[] {
  const record = readObjectRecord(changes);
  if (!record) {
    return [];
  }

  const parsed: CodexFileChange[] = [];
  for (const [filePath, rawChange] of Object.entries(record)) {
    const change = readObjectRecord(rawChange);
    if (!change) {
      continue;
    }
    const changeType = change.type === 'add' || change.type === 'delete' ? change.type : 'update';
    const texts = unifiedDiffToTexts(
      typeof change.unified_diff === 'string' ? change.unified_diff : '',
    );
    if (changeType === 'add') {
      texts.oldText = '';
      if (typeof change.content === 'string') texts.newText = change.content;
    } else if (changeType === 'delete') {
      texts.newText = '';
      if (typeof change.content === 'string') texts.oldText = change.content;
    }
    parsed.push({ filePath, changeType, ...texts });
  }

  return parsed;
}

type CodexPatchResult = { content: string; isError: boolean };
type CodexPatchRow = {
  timestamp?: string;
  toolId: string;
  toolName: 'Write' | 'Edit' | 'exec' | 'apply_patch';
  toolInput: AnyRecord | string;
  toolResult?: CodexPatchResult;
};

type CodexPatchCall = {
  callId: string;
  firstRowId: string;
  timestamp?: string;
  changes: CodexFileChange[];
  wrapper?: string;
  result?: CodexPatchResult;
  reported: boolean;
  fileCount: number;
};

function createCodexPatchTracker(timeline: CodexToolCallTimeline, publish: (row: CodexPatchRow) => void) {
  const calls = new Map<string, CodexPatchCall>();
  const openCalls = new Set<string>();
  const reportedIds = new Set<string>();

  function publishFiles(call: CodexPatchCall, changes: CodexFileChange[], toolResult?: CodexPatchResult) {
    const publishTool = (toolName: CodexPatchRow['toolName'], toolInput: CodexPatchRow['toolInput']) => {
      const index = call.fileCount++;
      publish({
        toolId: index === 0 ? call.firstRowId : `${call.callId}#${index}`, timestamp: call.timestamp,
        toolName, toolInput, toolResult,
      });
    };
    if (!changes.length) {
      if (call.wrapper) publishTool('exec', call.wrapper);
      else if (toolResult?.isError) publishTool('apply_patch', {});
    }
    for (const change of changes) {
      publishTool(change.changeType === 'add' ? 'Write' : 'Edit', {
        file_path: change.filePath,
        old_string: change.oldText,
        new_string: change.newText,
        ...(change.changeType === 'add' ? { content: change.newText } : {}),
        ...(change.changeType === 'delete' ? { deleted: true } : {}),
      });
    }
  }

  return {
    start(callId: string, firstRowId: string, timestamp: string | undefined, patches: (string | undefined)[], wrapper?: string) {
      const changes = patches.flatMap(patch => typeof patch === 'string' ? parseCodexPatch(patch) : []);
      calls.set(callId, { callId, firstRowId, timestamp, changes, wrapper, reported: false, fileCount: 0 });
      openCalls.add(callId);
    },
    report(payload: AnyRecord, timestamp: string | undefined): boolean {
      const legacy = payload.type === 'patch_apply_end';
      if (!legacy && (payload.type !== 'item_completed' || payload.item?.type !== 'FileChange')) return false;
      const item = legacy ? payload : payload.item;
      const id = readNonEmptyString(legacy ? item.call_id : item.id);
      if (!id || reportedIds.has(id)) return true;
      reportedIds.add(id);

      let ownerId = legacy ? id : timeline.ownerOf(payload) ?? id;
      // Older nested patch reports have a separate call_id and no start time.
      if (legacy && !calls.has(ownerId) && openCalls.size === 1) [ownerId] = openCalls;
      const call: CodexPatchCall = calls.get(ownerId) ?? {
        callId: id, firstRowId: `${id}#0`, timestamp, changes: [], fileCount: 0, reported: false,
      };
      call.reported = true;
      const isError = legacy ? item.success === false : ['failed', 'declined', 'cancelled', 'canceled', 'aborted'].includes(item.status);
      const content = isError ? String(item.stderr || item.stdout || 'Patch failed') : String(item.stdout || '');
      const changes = readPatchApplyChanges(item.changes);
      if (changes.length || isError) publishFiles(call, changes.length ? changes : call.changes, { content, isError });
      return true;
    },
    output(callId: string, rawOutput: string) {
      const call = calls.get(callId);
      if (!call) return;
      const cleaned = cleanCodexShellOutput(rawOutput);
      if (cleaned.runningCellId) return;
      openCalls.delete(callId);
      call.result = { content: cleaned.output, isError: cleaned.exitCode !== undefined && cleaned.exitCode !== 0 };
    },
    finish() {
      // A historical rollout can lack the native report. Only then use the source of the call.
      for (const call of calls.values()) {
        if (call.reported) continue;
        publishFiles(call, call.changes, call.result);
      }
    },
  };
}

// в”Ђв”Ђв”Ђ Subagents в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

type CodexSubagentRecord = {
  toolCallId: string;
  message: AnyRecord;
  agentPath?: string;
  agentThreadId?: string;
  isComplete: boolean;
};

function parseCodexSubagentMessage(payload: AnyRecord): {
  author: string;
  messageType: string;
  result: string;
} | null {
  const text = extractCodexTextContent(payload.content);
  const header = /Message Type:\s*([^\r\n]+)[\s\S]*?Sender:\s*([^\r\n]+)[\s\S]*?Payload:\s*\r?\n([\s\S]*)/i.exec(text);
  const author = readNonEmptyString(payload.author) || header?.[2]?.trim();
  if (!author) {
    return null;
  }

  return {
    author,
    messageType: header?.[1]?.trim().toUpperCase() || 'MESSAGE',
    result: header?.[3]?.trim() || '',
  };
}

/**
 * Codex names a spawned agent's rollout file `rollout-<timestamp>-<threadId>`
 * and writes it next to the parent's. Look there first, then widen to the
 * enclosing day/month directories so a run that crosses midnight still
 * resolves, and give up rather than walking the whole archive.
 */
async function findCodexSubagentRollout(
  parentFilePath: string,
  agentThreadId: string,
): Promise<string | null> {
  const suffix = `-${agentThreadId}.jsonl`;
  let directory = path.dirname(parentFilePath);

  for (let level = 0; level <= SUBAGENT_LOOKUP_PARENT_LEVELS; level += 1) {
    const match = await findFileWithSuffix(directory, suffix, level === 0 ? 0 : level, true);
    if (match) {
      return match;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return null;
}

/** The TUI runtime uses the exact native id until the session watcher has indexed its rollout. */
export async function findCodexRollout(threadId: string, searchArchive: boolean) {
  const root = path.join(getCodexHome(), 'sessions');
  const suffix = '-' + threadId + '.jsonl';
  // A UUIDv7 carries its creation time; the CLI can file it on either side of UTC midnight.
  if (/^[\da-f]{8}-[\da-f]{4}-7/i.test(threadId)) {
    const createdAt = parseInt(threadId.slice(0, 13).replace('-', ''), 16);
    for (const days of [0, -1, 1]) {
      const date = new Date(createdAt + days * 86_400_000).toISOString().slice(0, 10).split('-');
      const match = await findFileWithSuffix(path.join(root, ...date), suffix, 0);
      if (match) return match;
    }
    if (!searchArchive) return null;
  }
  return findFileWithSuffix(root, suffix, 3);
}

/** Depth-limited search for a file whose name ends with `suffix`. */
async function findFileWithSuffix(directory: string, suffix: string, depth: number, includeCompressed = false): Promise<string | null> {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirectories.push(path.join(directory, entry.name));
      continue;
    }
    if (entry.name.endsWith(suffix) || (includeCompressed && entry.name.endsWith(suffix + '.zst'))) {
      return path.join(directory, entry.name);
    }
  }

  if (depth <= 0) {
    return null;
  }

  for (const subdirectory of subdirectories) {
    const match = await findFileWithSuffix(subdirectory, suffix, depth - 1, includeCompressed);
    if (match) {
      return match;
    }
  }

  return null;
}

type CodexSubagentTranscript = {
  activity: SubagentActivity[];
  nickname?: string;
  agentPath?: string;
  model?: string;
};

/**
 * Flattens a spawned agent's own rollout into the shared activity timeline.
 *
 * The subagent's transcript is the same format as the parent's, so its shell
 * and patch calls go through the same translation and end up rendered by the
 * same components as the main thread's.
 */
async function readCodexSubagentTranscript(filePath: string): Promise<CodexSubagentTranscript> {
  const readRowId = createCodexRowIdReader();
  const activity: SubagentActivity[] = [];
  const transcript: CodexSubagentTranscript = { activity };
  const pendingResults = new Map<string, SubagentActivity>();
  const recordedCalls = new CodexToolCallTimeline();
  const patchCalls = createCodexPatchTracker(recordedCalls, row => activity.push({ kind: 'tool', ...row }));

  for await (const entry of readCodexTranscriptEntries(filePath)) {
    const payload = readObjectRecord(entry.payload);
    if (!payload) {
      continue;
    }

    recordedCalls.observe(entry, payload);
    if (entry.type === 'session_meta') {
      // A resumed rollout writes a second, sparser session_meta; assigning
      // unconditionally would erase the identity the first one carried.
      transcript.nickname = readNonEmptyString(payload.agent_nickname) ?? transcript.nickname;
      transcript.agentPath = readNonEmptyString(payload.agent_path) ?? transcript.agentPath;
      continue;
    }

    if (entry.type === 'turn_context') {
      transcript.model = readNonEmptyString(payload.model) ?? transcript.model;
      continue;
    }

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    if (entry.type === 'event_msg') patchCalls.report(payload, timestamp);
    if (entry.type !== 'response_item') {
      continue;
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const content = extractCodexTextContent(payload.content).trim();
      if (content) {
        activity.push({ kind: 'text', content, timestamp });
      }
      continue;
    }

    if (payload.type === 'reasoning') {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.map((item: AnyRecord) => item?.text).filter(Boolean).join('\n')
        : '';
      if (summary.trim()) {
        activity.push({ kind: 'thinking', content: summary, timestamp });
      }
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = readNonEmptyString(payload.call_id) ?? readRowId(entry);
      const shellRows: SubagentActivity[] = [];
      for (const child of translateCodexToolCall(payload, callId, timestamp, patchCalls)) {
        const record: SubagentActivity = { ...child, timestamp };
        activity.push(record);
        pendingResults.set(callId, record);
        if (record.toolName === 'Bash' || record.toolName === 'Exec') shellRows.push(record);
      }
      if (payload.name === 'exec' && shellRows.length) recordedCalls.watchCommands(callId, commands => {
        if (commands.length < shellRows.length) return;
        shellRows.forEach((row, index) => {
          const command = index === shellRows.length - 1 ? commands.slice(index).join('\n') : commands[index];
          row.toolName = 'Bash';
          row.toolInput = { ...readObjectRecord(row.toolInput), command };
        });
      });
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = readNonEmptyString(payload.call_id) ?? readNonEmptyString(payload.id);
      const rawOutput = extractCodexToolOutput(payload.output);
      if (callId) patchCalls.output(callId, rawOutput);
      const target = callId ? pendingResults.get(callId) : undefined;
      if (!target) {
        continue;
      }
      const cleaned = cleanCodexShellOutput(rawOutput);
      target.toolResult = {
        content: cleaned.output,
        isError: cleaned.exitCode !== undefined && cleaned.exitCode !== 0,
      };
    }
  }

  patchCalls.finish();
  return transcript;
}

/**
 * Translates one persisted Codex tool call into the canonical tool rows the
 * transcript renders. Most calls produce exactly one row; a patch produces one
 * per file it touched.
 *
 * Shared by the main thread and by subagent transcripts so a subagent's shell
 * command looks identical to the parent's.
 */
function translateCodexToolCall(
  payload: AnyRecord, callId: string, timestamp: string | undefined, patchCalls: ReturnType<typeof createCodexPatchTracker>,
): SubagentActivity[] {
  const name = readNonEmptyString(payload.name) ?? 'tool';
  const rawInput = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;

  if (name === 'exec') {
    const operations = parseCodexExecScript(rawInput);
    const patches = operations.filter(operation => operation.kind === 'patch');
    const hasComputedShell = operations.some(operation => operation.kind === 'unresolved-shell');
    const rows: SubagentActivity[] = [];
    if (hasComputedShell) rows.push({ kind: 'tool', toolId: callId, toolName: 'Exec', toolInput: rawInput });
    for (const operation of operations) {
      if (operation.kind === 'shell' && !hasComputedShell) {
        rows.push({
          kind: 'tool',
          toolId: callId,
          toolName: 'Bash',
          toolInput: { command: operation.command, description: operation.justification },
        });
      } else if (operation.kind === 'search') {
        rows.push({
          kind: 'tool',
          toolId: callId,
          toolName: 'WebSearch',
          toolInput: { query: operation.queries.join(' | ') },
        });
      }
    }
    if (patches.length > 0) {
      const firstRowId = rows.length ? `${callId}#0` : callId;
      patchCalls.start(callId, firstRowId, timestamp, patches.map(operation => operation.patch), rows.length ? undefined : rawInput);
    }
    if (rows.length > 0 || patches.length > 0) {
      return rows;
    }
  }

  if (name === 'shell_command' || name === 'exec_command') {
    let command = '';
    try {
      const args = JSON.parse(String(rawInput || '{}')) as AnyRecord;
      command = String(args.command ?? args.cmd ?? '');
    } catch {
      command = String(rawInput ?? '');
    }
    return [{ kind: 'tool', toolId: callId, toolName: 'Bash', toolInput: { command } }];
  }

  if (name === 'apply_patch') {
    patchCalls.start(callId, callId, timestamp, [rawInput]);
    return [];
  }

  if (name === 'update_plan') {
    return [{ kind: 'tool', toolId: callId, toolName: 'TodoWrite', toolInput: readCodexPlanInput(rawInput) }];
  }

  return [{ kind: 'tool', toolId: callId, toolName: humanizeCodexToolName(name), toolInput: rawInput }];
}

/**
 * Converts Codex's `update_plan` steps into the todo shape Claude's
 * `TodoWrite` already uses, so one renderer covers both providers.
 */
function readCodexPlanInput(rawArguments: unknown): AnyRecord {
  try {
    const parsed = JSON.parse(String(rawArguments || '{}')) as AnyRecord;
    const steps = Array.isArray(parsed.plan) ? parsed.plan : [];
    return {
      todos: steps.map((step: AnyRecord) => ({
        content: typeof step?.step === 'string' ? step.step : String(step?.content ?? ''),
        status: typeof step?.status === 'string' ? step.status : 'pending',
      })),
    };
  } catch {
    return { todos: [] };
  }
}

function humanizeCodexToolName(toolName: string): string {
  return toolName
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const CODEX_COLLABORATION_CONTROL_TOOLS = new Set([
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'wait_agent',
]);

// в”Ђв”Ђв”Ђ Transcript reader в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * Reads one Codex rollout file and produces the compact per-message records
 * `normalizeHistoryEntry` turns into `NormalizedMessage`s.
 */
async function getCodexSessionMessages(sessionId: string): Promise<CodexHistoryResult> {
  const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

  if (!sessionFilePath) {
    console.warn(`Codex session file not found for session ${sessionId}`);
    return { messages: [], total: 0, hasMore: false };
  }

  return readCodexRollout(readCodexTranscriptEntries(sessionFilePath), sessionFilePath);
}

/** Decodes both persisted history and the appended rows streamed by the Codex TUI runtime. */
export async function readCodexRollout(entries: AsyncIterable<AnyRecord>, sessionFilePath?: string, onMessage?: (message: AnyRecord) => void): Promise<CodexHistoryResult> {
  const readRowId = createCodexRowIdReader();
  const recordedCalls = new CodexToolCallTimeline();
  const messages: AnyRecord[] = [];
  const idlessPromptsPerTimestamp = new Map<string, number>();
  const publish = (message: AnyRecord) => {
    // Older rollouts omit item IDs. Two queued prompts can share a timestamp.
    if (message.type === 'user' && !message.uuid) {
      const ordinal = idlessPromptsPerTimestamp.get(message.timestamp) ?? 0;
      idlessPromptsPerTimestamp.set(message.timestamp, ordinal + 1);
      message.uuid = `codex-user:${message.timestamp}:${ordinal}`;
    }
    messages.push(message);
    onMessage?.(message);
  };
  let tokenUsage: AnyRecord | null = null;

  /** Call ids whose orchestration wrapper must never reach the transcript. */
  const ignoredToolCallIds = new Set<string>();
  /** Exec calls that own a shell row, so their output can be routed back. */
  const shellCallMessages = new Map<string, AnyRecord>();
  const patchCalls = createCodexPatchTracker(recordedCalls, row => {
    const { toolId: toolCallId, timestamp, toolName, toolResult } = row;
    const toolInput = typeof row.toolInput === 'string' ? row.toolInput : JSON.stringify(row.toolInput);
    publish({ type: 'tool_use', toolCallId, timestamp, toolName, toolInput });
    if (toolResult) publish({ type: 'tool_result', toolCallId, timestamp, output: toolResult.content, isError: toolResult.isError });
  });
  const execCallByCellId = new Map<string, string>();
  const waitCallToExecCall = new Map<string, string>();
  const pendingExecOutput = new Map<string, string>();
  const completedExecCalls = new Set<string>();
  /** Newest still-running exec call, for `write_stdin` polls that carry no cell id. */
  let runningExecCallId: string | null = null;

  const subagentsByCallId = new Map<string, CodexSubagentRecord>();
  const subagentsByPath = new Map<string, CodexSubagentRecord>();
  const turns = createCodexTurnTracker();
  /** Turns whose prompt already carries the anchor, so only the first does. */
  const anchoredTurnIds = new Set<string>();


  /** Emits a tool_result row unless the call already produced one. */
  const pushToolResult = (callId: string, timestamp: string, output: string, isError: boolean) => {
    if (completedExecCalls.has(callId)) {
      return;
    }
    completedExecCalls.add(callId);
    publish({ type: 'tool_result', timestamp, toolCallId: callId, output, isError });
  };

  const watchShellRow = (row: AnyRecord, description?: string) => {
    recordedCalls.watchCommands(row.toolCallId, commands => {
      const toolInput = JSON.stringify({ command: commands.join('\n'), description });
      if (row.toolName === 'Bash' && row.toolInput === toolInput) return;
      row.toolName = 'Bash';
      row.toolInput = toolInput;
      onMessage?.(row);
    });
  };

  for await (const entry of entries) {
    const payload = readObjectRecord(entry.payload);
    if (!payload) {
      continue;
    }
    recordedCalls.observe(entry, payload);
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();
    // Before the type-specific branches: a turn is opened and closed by rows
    // that produce no transcript entry of their own, and each of those
    // branches ends in a `continue`.
    turns.observe(entry.type, payload);

    // в”Ђв”Ђ event_msg в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    if (entry.type === 'event_msg') {
      if (payload.type === 'token_count' && payload.info) {
        tokenUsage = readCodexUsage(entry) ?? tokenUsage;
        continue;
      }

      if (payload.type === 'sub_agent_activity' && payload.kind === 'started') {
        const eventId = readNonEmptyString(payload.event_id);
        const agentPath = readNonEmptyString(payload.agent_path);
        const agentThreadId = readNonEmptyString(payload.agent_thread_id);
        const subagent = eventId ? subagentsByCallId.get(eventId) : undefined;
        if (subagent) {
          subagent.agentThreadId = agentThreadId ?? subagent.agentThreadId;
          if (agentPath) {
            subagent.agentPath = agentPath;
            subagentsByPath.set(agentPath, subagent);
          }
        }
        continue;
      }

      if (patchCalls.report(payload, timestamp)) continue;

      if (payload.type === 'turn_aborted') {
        publish({
          type: 'status_note',
          uuid: readRowId(entry),
          timestamp,
          content: payload.reason === 'interrupted' ? 'Turn interrupted' : `Turn aborted (${String(payload.reason ?? 'unknown')})`,
        });
        continue;
      }

      if (payload.type === 'context_compacted') {
        publish({ type: 'status_note', uuid: readRowId(entry), timestamp, content: 'Context compacted' });
        continue;
      }

      const prompt = readCodexUserPrompt(payload);
      if (prompt) {
        // Only the first prompt of a turn is anchored. A turn can hold more
        // than one вЂ” a follow-up queued while the turn was running is written
        // into it вЂ” and the cut is per turn, so anchoring the second would
        // quietly take the first with it when the user edited only the second.
        const turnId = turns.getCurrentTurnId();
        const isFirstPromptOfTurn = Boolean(turnId) && !anchoredTurnIds.has(turnId as string);
        if (isFirstPromptOfTurn) {
          anchoredTurnIds.add(turnId as string);
        }
        publish({
          type: 'user',
          uuid: prompt.id,
          timestamp,
          message: { role: 'user', content: prompt.content },
          images: prompt.images,
          ...(isFirstPromptOfTurn ? { turnId } : {}),
        });
      }
      continue;
    }

    if (entry.type !== 'response_item') {
      continue;
    }

    // в”Ђв”Ђ response_item в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
    if (payload.type === 'message' && payload.role === 'assistant') {
      const cited = readCodexMemoryCitations(extractCodexTextContent(payload.content));
      const textContent = cited.text;
      if (!textContent.trim()) {
        continue;
      }

      const proposedPlan = readCodexProposedPlan(textContent);
      if (proposedPlan) {
        const planCallId = readRowId(entry);
        publish({
          type: 'tool_use',
          timestamp,
          toolName: 'ExitPlanMode',
          toolInput: JSON.stringify({ plan: proposedPlan }),
          toolCallId: planCallId,
          memoryCitations: cited.memoryCitations,
        });
        publish({ type: 'tool_result', timestamp, toolCallId: planCallId, output: '' });
        continue;
      }

      publish({
        type: 'assistant',
        uuid: readRowId(entry),
        timestamp,
        message: { role: 'assistant', content: textContent },
        memoryCitations: cited.memoryCitations,
      });
      continue;
    }

    if (payload.type === 'reasoning') {
      const summaryText = Array.isArray(payload.summary)
        ? payload.summary.map((item: AnyRecord) => item?.text).filter(Boolean).join('\n')
        : '';
      if (summaryText.trim()) {
        publish({
          type: 'thinking',
          uuid: readRowId(entry),
          timestamp,
          message: { role: 'assistant', content: summaryText },
        });
      }
      continue;
    }

    if (payload.type === 'web_search_call') {
      const action = readObjectRecord(payload.action);
      const query = readNonEmptyString(action?.query as string | undefined);
      if (query) {
        const callId = readRowId(entry);
        publish({
          type: 'tool_use',
          timestamp,
          toolName: 'WebSearch',
          toolInput: JSON.stringify({ query }),
          toolCallId: callId,
        });
      }
      continue;
    }

    if (payload.type === 'agent_message') {
      const agentMessage = parseCodexSubagentMessage(payload);
      if (!agentMessage || agentMessage.messageType !== 'FINAL_ANSWER' || !agentMessage.result) {
        continue;
      }

      let subagent = subagentsByPath.get(agentMessage.author);
      if (!subagent) {
        // A resumed thread can replay an answer whose spawn call is not in this
        // file. Synthesize the container so the answer still has a home.
        const fallbackCallId = readRowId(entry);
        const taskName = agentMessage.author.split('/').filter(Boolean).pop() || 'agent';
        const taskMessage: AnyRecord = {
          uuid: fallbackCallId,
          type: 'tool_use',
          timestamp,
          toolName: 'Task',
          toolInput: JSON.stringify({ description: humanizeCodexToolName(taskName) }),
          toolCallId: fallbackCallId,
        };
        publish(taskMessage);
        subagent = { toolCallId: fallbackCallId, message: taskMessage, agentPath: agentMessage.author, isComplete: false };
        subagentsByCallId.set(fallbackCallId, subagent);
        subagentsByPath.set(agentMessage.author, subagent);
      }

      if (!subagent.isComplete) {
        publish({
          type: 'tool_result',
          timestamp,
          toolCallId: subagent.toolCallId,
          output: agentMessage.result,
        });
        subagent.isComplete = true;
      }
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = readNonEmptyString(payload.call_id) ?? readRowId(entry);
      const name = readNonEmptyString(payload.name) ?? 'tool';
      const rawInput = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;

      if (name === 'spawn_agent') {
        let taskName = 'agent';
        let prompt: string | undefined;
        try {
          const args = JSON.parse(String(rawInput || '{}')) as AnyRecord;
          taskName = readNonEmptyString(args.task_name) || taskName;
          // `message` is an encrypted transport blob on collaboration spawns вЂ”
          // only surface it when it is readable prompt text.
          const message = readNonEmptyString(args.message);
          prompt = message && !/^gAAAAA/.test(message) ? message : undefined;
        } catch {
          // The activity event still supplies the canonical agent path.
        }

        const taskMessage: AnyRecord = {
          uuid: callId,
          type: 'tool_use',
          timestamp,
          toolName: 'Task',
          // No `subagent_type`: Codex has no agent presets, and naming the
          // provider there would render as "Codex / Codex" in the transcript.
          toolInput: JSON.stringify({
            description: humanizeCodexToolName(taskName),
            ...(prompt ? { prompt } : {}),
          }),
          toolCallId: callId,
        };
        publish(taskMessage);
        subagentsByCallId.set(callId, { toolCallId: callId, message: taskMessage, isComplete: false });
        ignoredToolCallIds.add(callId);
        continue;
      }

      if (name === 'wait') {
        try {
          const args = JSON.parse(String(rawInput || '{}')) as AnyRecord;
          const execCallId = execCallByCellId.get(String(args.cell_id || ''));
          if (execCallId) {
            waitCallToExecCall.set(callId, execCallId);
          }
        } catch {
          // Suppress the orchestration wait even when its payload is malformed.
        }
        ignoredToolCallIds.add(callId);
        continue;
      }

      if (CODEX_COLLABORATION_CONTROL_TOOLS.has(name)) {
        ignoredToolCallIds.add(callId);
        continue;
      }

      if (name === 'update_plan') {
        publish({
          type: 'tool_use',
          timestamp,
          toolName: 'TodoWrite',
          toolInput: JSON.stringify(readCodexPlanInput(rawInput)),
          toolCallId: callId,
        });
        continue;
      }

      if (name === 'exec') {
        const operations = parseCodexExecScript(rawInput);
        const shellCommands = operations.filter((operation) => operation.kind === 'shell');
        const hasComputedShell = operations.some(operation => operation.kind === 'unresolved-shell');
        const stdinWrites = operations.filter((operation) => operation.kind === 'stdin');
        const patches = operations.filter((operation) => operation.kind === 'patch');
        const searches = operations.filter((operation) => operation.kind === 'search');
        const plans = operations.filter((operation) => operation.kind === 'plan');

        // A bare stdin poll continues whatever command is still running; it is
        // a continuation, not an action of its own.
        if (operations.length > 0 && shellCommands.length === 0 && patches.length === 0 && stdinWrites.length > 0) {
          ignoredToolCallIds.add(callId);
          if (runningExecCallId) {
            waitCallToExecCall.set(callId, runningExecCallId);
          }
          continue;
        }

        if (operations.length === 0) {
          // An unrecognized wrapper is shown as-is rather than mislabelled as a
          // shell command, so a new Codex tool degrades to a readable code
          // block instead of a wrong one.
          const fallbackMessage: AnyRecord = {
            type: 'tool_use',
            timestamp,
            toolName: 'exec',
            toolInput: rawInput,
            toolCallId: callId,
          };
          publish(fallbackMessage);
          watchShellRow(fallbackMessage);
          continue;
        }

        // The call has exactly one output, so whichever row represents the work
        // it did keeps the call id and receives that output. Extra rows get
        // suffixed ids and are resolved by their own bookkeeping.
        let toolRowCount = 0;
        const nextRowId = () => {
          const index = toolRowCount++;
          return index === 0 ? callId : `${callId}~${index}`;
        };

        if (hasComputedShell || shellCommands.length > 0) {
          const description = shellCommands.find((operation) => operation.justification)?.justification;
          const shellMessage: AnyRecord = {
            type: 'tool_use',
            timestamp,
            toolName: hasComputedShell ? 'exec' : 'Bash',
            toolInput: hasComputedShell ? rawInput : JSON.stringify({
              command: shellCommands.map((operation) => operation.command).join('\n'),
              description,
            }),
            toolCallId: nextRowId(),
          };
          publish(shellMessage);
          watchShellRow(shellMessage, description);
          shellCallMessages.set(callId, shellMessage);
        }

        for (const search of searches) {
          publish({
            type: 'tool_use',
            timestamp,
            toolName: 'WebSearch',
            toolInput: JSON.stringify({ query: search.queries.join(' | ') }),
            toolCallId: nextRowId(),
          });
        }

        for (const plan of plans) {
          // The script's own result covers whatever else it did, so the plan
          // row is closed here вЂ” without one it would read as still running.
          const planCallId = nextRowId();
          publish({
            type: 'tool_use',
            timestamp,
            toolName: 'TodoWrite',
            toolInput: JSON.stringify({ todos: plan.todos }),
            toolCallId: planCallId,
          });
          publish({ type: 'tool_result', timestamp, toolCallId: planCallId, output: '' });
        }

        if (patches.length > 0) {
          const firstRowId = nextRowId();
          patchCalls.start(callId, firstRowId, timestamp, patches.map(operation => operation.patch), firstRowId === callId ? rawInput : undefined);
          if (firstRowId === callId) ignoredToolCallIds.add(callId);
        }

        if (toolRowCount === 0) {
          // Every recognized operation produced no row (an empty patch, say).
          // Nothing owns the output, so drop it rather than leaving it loose.
          ignoredToolCallIds.add(callId);
        }
        continue;
      }

      if (name === 'apply_patch') {
        patchCalls.start(callId, `${callId}#0`, timestamp, [rawInput]);
        ignoredToolCallIds.add(callId);
        continue;
      }

      if (name === 'shell_command' || name === 'exec_command') {
        let command = '';
        try {
          const args = JSON.parse(String(rawInput || '{}')) as AnyRecord;
          command = String(args.command ?? args.cmd ?? '');
        } catch {
          command = String(rawInput ?? '');
        }
        const shellMessage: AnyRecord = {
          type: 'tool_use',
          timestamp,
          toolName: 'Bash',
          toolInput: JSON.stringify({ command }),
          toolCallId: callId,
        };
        publish(shellMessage);
        shellCallMessages.set(callId, shellMessage);
        continue;
      }

      publish({
        type: 'tool_use',
        timestamp,
        toolName: name,
        toolInput: rawInput,
        toolCallId: callId,
      });
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = readNonEmptyString(payload.call_id) ?? readRowId(entry);
      const rawOutput = extractCodexToolOutput(payload.output);
      patchCalls.output(callId, rawOutput);

      // A wait / stdin poll delivers the tail of an earlier command's output.
      const continuedCallId = waitCallToExecCall.get(callId);
      if (continuedCallId) {
        const cleaned = readCodexStdinOutput(rawOutput) ?? cleanCodexShellOutput(rawOutput);
        const accumulated = `${pendingExecOutput.get(continuedCallId) || ''}${cleaned.output}`;
        pendingExecOutput.set(continuedCallId, accumulated);
        if (!cleaned.runningCellId) {
          if (runningExecCallId === continuedCallId) {
            runningExecCallId = null;
          }
          pushToolResult(
            continuedCallId,
            timestamp,
            accumulated,
            cleaned.exitCode !== undefined && cleaned.exitCode !== 0,
          );
        }
        continue;
      }

      const subagent = subagentsByCallId.get(callId);
      if (subagent) {
        try {
          const taskPath = readNonEmptyString((JSON.parse(rawOutput) as AnyRecord).task_name);
          if (taskPath) {
            subagent.agentPath = taskPath;
            subagentsByPath.set(taskPath, subagent);
          }
        } catch {
          // The sub_agent_activity event normally supplies the path.
        }
        continue;
      }

      if (ignoredToolCallIds.has(callId)) {
        continue;
      }

      if (shellCallMessages.has(callId)) {
        const cleaned = cleanCodexShellOutput(rawOutput);
        if (cleaned.runningCellId) {
          execCallByCellId.set(cleaned.runningCellId, callId);
          pendingExecOutput.set(callId, cleaned.output);
          runningExecCallId = callId;
          continue;
        }
        const accumulated = `${pendingExecOutput.get(callId) || ''}${cleaned.output}`;
        pushToolResult(
          callId,
          timestamp,
          accumulated,
          cleaned.exitCode !== undefined && cleaned.exitCode !== 0,
        );
        continue;
      }

      pushToolResult(callId, timestamp, rawOutput, false);
    }
  }

  patchCalls.finish();

  if (sessionFilePath) await attachCodexSubagentTranscripts(sessionFilePath, subagentsByCallId);

  // A rollback is recorded after the turns it retires, so a prompt can be
  // anchored and then retired later in the same file. Its rows still render вЂ”
  // they are what the conversation looked like вЂ” but the turn is gone from the
  // thread, so the anchor goes with it and the message loses its pencil.
  for (const message of messages) {
    if (typeof message.turnId === 'string' && turns.isRolledBack(message.turnId)) {
      delete message.turnId;
    }
  }

  messages.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
  return { messages, tokenUsage: tokenUsage ?? undefined };
}

/**
 * Loads each spawned agent's own rollout and hangs its timeline off the
 * `Task` row that started it.
 */
async function attachCodexSubagentTranscripts(
  parentFilePath: string,
  subagentsByCallId: Map<string, CodexSubagentRecord>,
): Promise<void> {
  for (const record of subagentsByCallId.values()) {
    let parsedInput: AnyRecord = {};
    try {
      parsedInput = JSON.parse(String(record.message.toolInput || '{}')) as AnyRecord;
    } catch {
      parsedInput = {};
    }

    const agentName = record.agentPath?.split('/').filter(Boolean).pop();
    // Codex has no agent-type concept the way Claude does, so `type` is left
    // unset rather than filled with the provider's own name; the panel falls
    // back to a neutral label.
    const subagent: SubagentInfo = {
      id: record.agentThreadId ?? record.toolCallId,
      description: readNonEmptyString(parsedInput.description as string | undefined) ?? agentName,
      status: record.isComplete ? 'completed' : 'running',
    };

    if (record.agentThreadId) {
      const rolloutPath = await findCodexSubagentRollout(parentFilePath, record.agentThreadId);
      if (rolloutPath) {
        const transcript = await readCodexSubagentTranscript(rolloutPath);
        if (transcript.activity.length > 0) {
          record.message.subagentTools = transcript.activity
            .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
            .map(truncateSubagentActivity);
          subagent.activityCount = transcript.activity.length;
        }
        subagent.name = transcript.nickname ?? agentName;
        subagent.model = transcript.model;
      }
    }

    subagent.name = subagent.name ?? agentName;
    record.message.subagent = subagent;
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  /** The runtime and history loader share the compact rows produced by the rollout decoder. */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) return [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.toolCallId && (raw.type === 'tool_use' || raw.type === 'tool_result')
      ? `codex-${raw.type}:${raw.toolCallId}`
      : raw.uuid || generateMessageId('codex');

    if (raw.type === 'status_note' && typeof raw.content === 'string') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'task_notification',
        summary: raw.content,
        status: 'info',
      })];
    }

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string' ? raw.message.content : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
            .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
            .filter(Boolean)
            .join('\n')
          : String(raw.message.content || '');
      const parsedFiles = parseFilesInputTag(content);
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : undefined;
      const files = parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined;
      if (!parsedFiles.text.trim() && !rawImages && !files) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content: parsedFiles.text,
        images: rawImages,
        files,
        // Edits rewind a whole turn, which can contain several user messages.
        transcriptAnchorId: readNonEmptyString(raw.turnId),
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
            .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
            .filter(Boolean)
            .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
        memoryCitations: raw.memoryCitations,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
        subagentTools: raw.subagentTools,
        subagent: raw.subagent,
        memoryCitations: raw.memoryCitations,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when the
   * transcript reported it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: CodexHistoryResult;
    try {
      result = await getCodexSessionMessages(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of result.messages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
        }
      }
    }

    // Everything the transcript draws, and nothing else вЂ” so a page of N rows
    // is N rows the user sees, and `total` counts the same thing.
    const transcript = prepareTranscriptMessages(normalized);
    const total = transcript.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage: result.tokenUsage,
    };
  }
}
