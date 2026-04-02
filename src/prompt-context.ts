import type { CompactMessage, CompactResult } from './compact/types.js';
import { compactEngine } from './compact/index.js';
import { logger } from './logger.js';

export interface PreparedPromptMessages {
  messages: CompactMessage[];
  compactResult: CompactResult | null;
}

export function preparePromptMessages(
  messages: CompactMessage[],
  sessionId?: string,
): PreparedPromptMessages {
  if (!sessionId) {
    return {
      messages,
      compactResult: null,
    };
  }

  try {
    const result = compactEngine.compact(messages, sessionId);
    return {
      messages: result.messages,
      compactResult: result,
    };
  } catch (err) {
    logger.error(
      { err, sessionId },
      'Error during message compaction, falling back to original messages',
    );
    return {
      messages,
      compactResult: null,
    };
  }
}
