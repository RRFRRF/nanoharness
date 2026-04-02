import { STREAMING_CONFIG } from '../config.js';
import type { ProcessOptions } from '../streaming/index.js';
import { getStreamConfig } from './stream-commands.js';

export function resolveTerminalStreamOptions(
  groupName: string,
  sessionId: string,
): ProcessOptions {
  const runtime = getStreamConfig();

  return {
    sessionId,
    groupName,
    showThinking: runtime.showThinking ?? STREAMING_CONFIG.SHOW_THINKING,
    showPlan: runtime.showPlan ?? STREAMING_CONFIG.SHOW_PLAN,
    showTools: runtime.showTools ?? STREAMING_CONFIG.SHOW_TOOLS,
    collapseThinking:
      runtime.collapseThinking ?? STREAMING_CONFIG.THINKING_COLLAPSED,
    maxEvents: STREAMING_CONFIG.MAX_EVENTS,
  };
}
