import type { AnyRecord } from '@/shared/types.js';

export function readCodexUsage(entry: AnyRecord) {
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') return null;
  const info = entry.payload.info;
  const usage = info?.last_token_usage;
  if (!usage || typeof usage.total_tokens !== 'number') return null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  return {
    used: usage.total_tokens,
    total: typeof info.model_context_window === 'number' ? info.model_context_window : undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens: Number(usage.cached_input_tokens) || 0,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}
