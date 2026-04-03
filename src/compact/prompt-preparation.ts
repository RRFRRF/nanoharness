import type { CompactMessage, CompactResult } from './types.js';
import {
  applyFallbackCompaction,
  preparePromptMessages,
} from '../prompt-context.js';
import { CompactMode } from './native-compact.js';

export function buildCompactionHeader(result: CompactResult | null): string {
  if (!result) return '';
  if (result.level === 'NONE') return '';
  const { stats, level } = result;
  return ` compact_level="${level}" original_messages="${stats.totalMessages}" compacted="${stats.compactedCount}" tokens_before="${stats.tokensBefore}" tokens_after="${stats.tokensAfter}" compression_ratio="${stats.compressionRatio.toFixed(2)}"`;
}

export function prepareMessagesForPrompt(
  messages: CompactMessage[],
  sessionId?: string,
  nativeCompactFailed = false,
): ReturnType<typeof preparePromptMessages> {
  if (nativeCompactFailed) {
    return applyFallbackCompaction(messages, sessionId);
  }
  return preparePromptMessages(messages, sessionId);
}

export { CompactMode };
