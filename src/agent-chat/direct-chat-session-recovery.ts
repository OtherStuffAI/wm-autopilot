export interface DirectChatSessionReplacementDecision {
  reason: string;
  detail: string;
  requiresAcceptedPrompt?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function isDirectChatPromptReadinessTimeout(error: unknown): boolean {
  return /^Timed out waiting for session .+ to become prompt-ready\.(?: last readiness: .+)?$/u.test(errorMessage(error));
}

export function directChatSessionReplacementDecision(error: unknown): DirectChatSessionReplacementDecision | null {
  const message = errorMessage(error);
  if (isDirectChatPromptReadinessTimeout(error)) {
    return {
      reason: 'previous session did not become prompt-ready',
      detail: message,
    };
  }
  if (/^Timed out waiting for session .+ to produce a final response\.$/u.test(message)) {
    return {
      reason: 'previous session accepted the prompt but did not produce a final response',
      detail: message,
      requiresAcceptedPrompt: true,
    };
  }
  if (/^(?:No adapter available for session|Session .+ no longer has an adapter\.)/u.test(message)) {
    return {
      reason: 'previous session lost its runtime adapter',
      detail: message,
    };
  }
  return null;
}
