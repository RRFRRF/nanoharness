export type RunCompletionReason =
  | 'completed'
  | 'stream-complete'
  | 'idle-timeout'
  | 'timeout'
  | 'container-error'
  | 'session-error';

export interface NormalizedRunState {
  sentVisibleResult: boolean;
  observedQueryCompleted: boolean;
  observedStreamCompletion: boolean;
  hadStreamingActivity: boolean;
}

export interface NormalizedRunResult {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
  newSessionId?: string;
  lastAssistantUuid?: string;
  completionReason: RunCompletionReason;
  state: NormalizedRunState;
}

export function createNormalizedRunState(): NormalizedRunState {
  return {
    sentVisibleResult: false,
    observedQueryCompleted: false,
    observedStreamCompletion: false,
    hadStreamingActivity: false,
  };
}

export function markNormalizedOutput(
  state: NormalizedRunState,
  output: { result?: unknown; queryCompleted?: boolean },
): void {
  if (output.result) {
    state.sentVisibleResult = true;
  }
  if (output.queryCompleted) {
    state.observedQueryCompleted = true;
  }
}

export function markNormalizedStreamEvent(
  state: NormalizedRunState,
  event: { type: string },
): void {
  if (event.type !== 'error') {
    state.hadStreamingActivity = true;
  }
  if (event.type === 'complete') {
    state.observedStreamCompletion = true;
  }
}
