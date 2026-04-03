import type { CompactMessage, CompactResult } from './compact/types.js';
import { compactEngine } from './compact/index.js';
import {
  CompactMode,
  type NativeCompactRequest,
  type PromptPreparationMetadata,
} from './compact/native-compact.js';
import { logger } from './logger.js';

export interface PreparedPromptMessages {
  messages: CompactMessage[];
  compactResult: CompactResult | null;
  nativeCompact: NativeCompactRequest;
}

function createNativeCompactRequest(
  sessionId?: string,
  compactResult: CompactResult | null = null,
): NativeCompactRequest {
  const metadata: PromptPreparationMetadata = {
    compactMode: compactResult
      ? CompactMode.FALLBACK_RULE
      : CompactMode.NATIVE_LLM,
    requestedNativeCompact: !!sessionId,
  };

  return {
    enabled: !!sessionId,
    sessionId,
    metadata,
  };
}

export function preparePromptMessages(
  messages: CompactMessage[],
  sessionId?: string,
): PreparedPromptMessages {
  if (!sessionId) {
    return {
      messages,
      compactResult: null,
      nativeCompact: createNativeCompactRequest(undefined),
    };
  }

  return {
    messages,
    compactResult: null,
    nativeCompact: createNativeCompactRequest(sessionId),
  };
}

export function applyFallbackCompaction(
  messages: CompactMessage[],
  sessionId?: string,
): PreparedPromptMessages {
  if (!sessionId) {
    return {
      messages,
      compactResult: null,
      nativeCompact: createNativeCompactRequest(undefined),
    };
  }

  try {
    const result = compactEngine.compact(messages, sessionId);
    return {
      messages: result.messages,
      compactResult: result,
      nativeCompact: createNativeCompactRequest(sessionId, result),
    };
  } catch (err) {
    logger.error(
      { err, sessionId },
      'Error during fallback message compaction, falling back to original messages',
    );
    return {
      messages,
      compactResult: null,
      nativeCompact: createNativeCompactRequest(sessionId),
    };
  }
}
