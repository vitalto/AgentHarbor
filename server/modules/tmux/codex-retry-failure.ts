import { readObjectRecord } from '@/shared/index.js';

const transportErrors = new Set([
  'http_connection_failed', 'response_stream_connection_failed', 'response_stream_disconnected',
  'response_too_many_failed_attempts',
]);
const permanentFailure = /\b(?:unauthorized|forbidden|quota|authentication|invalid api key|permission denied|billing|usage[ _-]limit|rate[ _-]limit(?:ed)?|too many requests|context window|policy violation|interrupted|cancelled|canceled)\b/i;
const permanentHttpStatus = /\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+status)?|(?:last\s+)?status(?:\s+code)?)\s*[:=]?\s*4(?!08)\d\d\b/i;
const networkMessage = /^(?:stream disconnected before completion\b|connection (?:reset by peer|timed out)\b|(?:error|failed) (?:sending request for url|to connect to (?:the )?(?:api|server))\b|timed out (?:waiting for|connecting to)\b)/i;

function classifyFailure(value: unknown): string | null {
  const error = readObjectRecord(value);
  if (!error) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  if (permanentFailure.test(message) || permanentHttpStatus.test(message)) return null;
  const details = readObjectRecord(error.codex_error_info);
  const code = details ? Object.keys(details)[0] : error.codex_error_info;
  if (code === 'internal_server_error' || code === 'server_overloaded') return 'Codex API server error';
  if (transportErrors.has(code)) {
    const status = details?.[code]?.http_status_code;
    const interruptedStream = code === 'response_stream_disconnected' && status >= 200 && status <= 299;
    if (status != null && !(Number.isInteger(status) && (interruptedStream || status === 408 || (status >= 500 && status <= 599)))) return null;
    return 'Codex API connection failed';
  }
  // Older releases put transport failures under "other". Only trust Codex's error event and its known prefixes.
  return (code == null || code === 'other') && networkMessage.test(message) ? 'Codex API connection failed' : null;
}

/** The tmux retry sweep uses Codex's terminal error events, user inputs and tool progress from the rollout. */
export function readCodexRetryFailure(tail: string, marker: string) {
  let turnId: string | null = null;
  let retriesSent: number | null = null;
  let failure: { errorAt: number; errorUuid: string; errorText: string } | null = null;
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try { row = readObjectRecord(JSON.parse(line)); } catch { continue; }
    const payload = readObjectRecord(row?.payload);
    if (!row || !payload) continue;
    if (row.type === 'response_item') {
      failure = null;
      if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) retriesSent = 0;
      continue;
    }
    if (row.type !== 'event_msg') continue;
    switch (payload.type) {
      case 'task_started':
      case 'turn_started':
        turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
        retriesSent = null;
        failure = null;
        break;
      case 'user_message': {
        const input = typeof payload.message === 'string' ? payload.message : '';
        const retry = input.startsWith(marker) ? /^ (\d+)\/\d+: /.exec(input.slice(marker.length)) : null;
        retriesSent = retry ? Number(retry[1]) : 0;
        failure = null;
        break;
      }
      case 'error':
      case 'task_complete':
      case 'turn_complete': {
        const complete = payload.type !== 'error';
        if (complete && !Object.hasOwn(payload, 'error') && !payload.last_agent_message
          && (!turnId || !payload.turn_id || turnId === payload.turn_id)) break;
        const errorText = classifyFailure(complete ? payload.error : payload);
        if (complete && typeof payload.turn_id === 'string') turnId = payload.turn_id;
        const errorAt = Date.parse(row.timestamp);
        failure = errorText && Number.isFinite(errorAt)
          ? { errorAt, errorText, errorUuid: turnId ?? String(errorAt) } : null;
        break;
      }
      case 'turn_aborted':
      case 'thread_rolled_back':
        retriesSent = null;
        failure = null;
        break;
      case 'agent_message':
      case 'agent_reasoning':
      case 'stream_error':
        failure = null;
        break;
    }
  }
  // If a bounded tail lost both the last user message and all tool progress, its retry count is unknowable.
  return failure && retriesSent !== null ? { ...failure, retriesSent } : null;
}
