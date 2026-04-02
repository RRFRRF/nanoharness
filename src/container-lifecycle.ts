import type { StreamEvent } from './streaming/index.js';
import type { ContainerOutput } from './container-runner.js';

export interface ContainerLifecycleState {
  hadOutputActivity: boolean;
  newSessionId?: string;
  lastAssistantUuid?: string;
}

export function createContainerLifecycleState(
  sessionId?: string,
  lastAssistantUuid?: string,
): ContainerLifecycleState {
  return {
    hadOutputActivity: false,
    newSessionId: sessionId,
    lastAssistantUuid,
  };
}

export function trackContainerOutput(
  state: ContainerLifecycleState,
  output: ContainerOutput,
): void {
  if (output.newSessionId) {
    state.newSessionId = output.newSessionId;
  }
  if (output.lastAssistantUuid) {
    state.lastAssistantUuid = output.lastAssistantUuid;
  }
  if (output.result || output.event || output.queryCompleted) {
    state.hadOutputActivity = true;
  }
}

export function trackContainerStreamEvent(
  state: ContainerLifecycleState,
  event: StreamEvent,
): void {
  if (event.type !== 'error') {
    state.hadOutputActivity = true;
  }
}
