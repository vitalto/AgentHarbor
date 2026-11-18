import type { AnyRecord } from '@/shared/index.js';

type ToolCallWindow = {
  name: string;
  start: number;
  end?: number;
  commands?: Map<string, { text: string; start: number }>;
  updateCommands?: (commands: string[]) => void;
};

function readExecutedCommand(item: AnyRecord): string | undefined {
  const argv = item.command;
  if (typeof argv === 'string') return argv;
  if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string')) return;
  if (argv.length === 1) return argv[0];
  const executable = argv[0].split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  const switchName = argv[argv.length - 2];
  if ((/^(?:pwsh|powershell)$/.test(executable) && /^-(?:command|c)$/i.test(switchName))
    || (executable === 'cmd' && /^\/[ck]$/i.test(switchName))
    || (/^(?:sh|bash|zsh|dash|ksh|fish)$/.test(executable) && /^-[a-z]*c[a-z]*$/.test(switchName))) {
    return argv.at(-1);
  }
  // Joining raw argv would discard quoting and can change what copying the command runs.
  if (item.parsed_cmd?.length === 1 && typeof item.parsed_cmd[0]?.cmd === 'string') return item.parsed_cmd[0].cmd;
}

/** The Codex history and live readers share this index because nested executions have their own IDs. */
export class CodexToolCallTimeline {
  private calls = new Map<string, ToolCallWindow>();
  private owners = new Map<string, string>();
  private cells = new Map<string, string>();
  private waits = new Map<string, string>();
  private turnId?: string;

  observe(entry: AnyRecord, payload: AnyRecord): void {
    if (entry.type === 'turn_context' || (entry.type === 'event_msg' && ['task_started', 'turn_started'].includes(payload.type))) {
      if (payload.turn_id && payload.turn_id !== this.turnId) {
        this.calls.clear();
        this.owners.clear();
        this.cells.clear();
        this.waits.clear();
        this.turnId = payload.turn_id;
      }
      return;
    }
    if (entry.type === 'response_item') {
      const id = payload.call_id || payload.id;
      if (!id) return;
      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        if (['exec', 'exec_command', 'shell_command', 'apply_patch'].includes(payload.name)) {
          this.calls.set(id, { name: payload.name, start: Date.parse(entry.timestamp) });
        } else if (payload.name === 'wait') {
          const cellId = typeof payload.arguments === 'string' && /"cell_id"\s*:\s*"([^"]+)"/.exec(payload.arguments)?.[1];
          const owner = cellId && this.cells.get(cellId);
          if (owner) this.waits.set(id, owner);
        }
      } else if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        const owner = this.waits.get(id) ?? id;
        const call = this.calls.get(owner);
        if (!call) return;
        const header = typeof payload.output === 'string' ? payload.output : payload.output?.[0]?.text;
        const cellId = typeof header === 'string' && /^Script running with cell ID\s+(\S+)/i.exec(header)?.[1];
        if (cellId) this.cells.set(cellId, owner);
        else call.end = Date.parse(entry.timestamp);
      }
      return;
    }
    const item = payload.item;
    if (entry.type !== 'event_msg' || !['item_started', 'item_completed'].includes(payload.type)
      || item?.type !== 'CommandExecution' || !item.id || ['user_shell', 'unified_exec_interaction'].includes(item.source)) return;
    const id = this.ownerOf(payload);
    const call = id && this.calls.get(id);
    if (!call || !call.commands || !call.updateCommands) return;
    const text = readExecutedCommand(item);
    if (!text || call.commands.get(item.id)?.text === text) return;
    call.commands.set(item.id, { text, start: payload.started_at_ms ?? Date.parse(entry.timestamp) });
    const commands = [...call.commands.values()].sort((a, b) => a.start - b.start);
    call.updateCommands(commands.map(command => command.text));
  }

  watchCommands(callId: string, update: (commands: string[]) => void): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.commands = new Map();
    call.updateCommands = update;
  }

  ownerOf(payload: AnyRecord): string | undefined {
    if (this.turnId && payload.turn_id && this.turnId !== payload.turn_id) return;
    const item = payload.item;
    const nativeId = item?.id;
    for (const id of [payload.call_id, item?.call_id, nativeId]) {
      if (id && this.calls.has(id)) return id;
    }
    const knownOwner = this.owners.get(nativeId);
    if (knownOwner) return knownOwner;

    // Completion can arrive during a later call. Match the start against the
    // enclosing call's lifetime, and leave overlapping calls alone when IDs differ.
    const started = payload.started_at_ms;
    const tools = item?.type === 'FileChange' ? ['exec', 'apply_patch'] : ['exec', 'exec_command', 'shell_command'];
    let owner: string | undefined;
    for (const [id, call] of this.calls) {
      if (!tools.includes(call.name)) continue;
      if (typeof started === 'number' && Number.isFinite(call.start)) {
        if (started < call.start || (call.end !== undefined && started > call.end)) continue;
      } else if (call.end !== undefined) continue;
      if (owner) return;
      owner = id;
    }
    if (owner && nativeId) this.owners.set(nativeId, owner);
    return owner;
  }
}
