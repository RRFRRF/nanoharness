import type { CompactMessage, CompactResult } from './types.js';
import { preparePromptMessages } from '../prompt-context.js';

export function buildCompactionHeader(result: CompactResult | null): string {
  if (!result) return '';
  if (result.level === 'NONE') return '';
  const { stats, level } = result;
  return ` compact_level="${level}" original_messages="${stats.totalMessages}" compacted="${stats.compactedCount}" tokens_before="${stats.tokensBefore}" tokens_after="${stats.tokensAfter}" compression_ratio="${stats.compressionRatio.toFixed(2)}"`;
}

export function prepareMessagesForPrompt(
  messages: CompactMessage[],
  sessionId?: string,
): ReturnType<typeof preparePromptMessages> {
  return preparePromptMessages(messages, sessionId);
}
