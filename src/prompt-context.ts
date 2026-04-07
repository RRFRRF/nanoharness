import type { CompactMessage, CompactResult } from './compact/types.js';
import {
  CompactMode,
  type NativeCompactRequest,
  type PromptPreparationMetadata,
} from './compact/native-compact.js';

export interface PreparedPromptMessages {
  messages: CompactMessage[];
  compactResult: CompactResult | null;
  nativeCompact: NativeCompactRequest;
}

function createNativeCompactRequest(
  sessionId?: string,
): NativeCompactRequest {
  const metadata: PromptPreparationMetadata = {
    compactMode: CompactMode.RULE,
    requestedNativeCompact: false,
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
  return {
    messages,
    compactResult: null,
    nativeCompact: createNativeCompactRequest(sessionId),
  };
}
