export type RetryErrorKind =
  | 'provider-transient'
  | 'tool-timeout'
  | 'tool-failure'
  | 'cancelled'
  | 'checkpoint-missing'
  | 'container-failure'
  | 'other';

export interface RetryDecisionInput {
  attempt: number;
  maxAttempts: number;
  error?: string | null;
  sentVisibleResult?: boolean;
  observedCompletion?: boolean;
}

export function isTransientProviderError(error?: string | null): boolean {
  if (!error) return false;
  return /(?:\b429\b|rate limit|too many requests|temporarily unavailable|upstream service temporarily unavailable|暂不可用|\b5\d\d\b|bad gateway|gateway timeout|service unavailable|timeout|timed out|econnreset|socket hang up|connection reset|connection aborted|etimedout)/i.test(
    error,
  );
}

export function classifyRetryError(error?: string | null): RetryErrorKind {
  if (!error) return 'other';
  if (/checkpoint/i.test(error) && /(not found|missing|unknown)/i.test(error)) {
    return 'checkpoint-missing';
  }
  if (/(cancelled|canceled|aborted by user|scheduler cancel)/i.test(error)) {
    return 'cancelled';
  }
  if (/(tool|mcp).*(timed out|timeout)/i.test(error)) {
    return 'tool-timeout';
  }
  if (/(tool|mcp).*(failed|error)/i.test(error)) {
    return 'tool-failure';
  }
  if (/(container spawn error|container exited with code|container timed out)/i.test(error)) {
    return 'container-failure';
  }
  if (isTransientProviderError(error)) {
    return 'provider-transient';
  }
  return 'other';
}

export function shouldRetryTransientAttempt({
  attempt,
  maxAttempts,
  error,
  sentVisibleResult = false,
  observedCompletion = false,
}: RetryDecisionInput): boolean {
  return (
    attempt < maxAttempts &&
    !sentVisibleResult &&
    !observedCompletion &&
    classifyRetryError(error) === 'provider-transient'
  );
}
