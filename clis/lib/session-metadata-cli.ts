export interface SessionMetadataCliUpdateInput {
  goal?: string;
  nextAction?: string;
  nextActionPayload?: string;
  nextActionTemplate?: string;
  bindingType?: string;
  bindingId?: string;
  flowId?: string;
  flowRunId?: string;
  tags?: string;
}

const FULL_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shouldResolveSessionMetadataTargetId(
  requestedId: string,
  currentSessionId?: string,
): boolean {
  const target = requestedId.trim();
  if (!target) return true;
  if (currentSessionId?.trim() && target === currentSessionId.trim()) {
    return false;
  }
  return !FULL_SESSION_ID_RE.test(target);
}

export function buildSessionMetadataPath(
  sessionId: string,
  ownerNpub?: string,
): string {
  if (ownerNpub && ownerNpub.trim().length > 0) {
    return `/api/owners/${encodeURIComponent(ownerNpub)}/sessions/${encodeURIComponent(sessionId)}/metadata`;
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}/metadata`;
}

export function buildSessionMetadataUpdateBody(
  input: SessionMetadataCliUpdateInput,
): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {};

  if (input.goal !== undefined) payload.goal = input.goal;
  if (input.nextAction !== undefined) payload.nextAction = input.nextAction;
  if (input.nextActionPayload !== undefined) payload.nextActionPayload = input.nextActionPayload;
  if (input.nextActionTemplate !== undefined) payload.nextActionTemplate = input.nextActionTemplate;
  if (input.bindingType !== undefined) payload.bindingType = input.bindingType;
  if (input.bindingId !== undefined) payload.bindingId = input.bindingId;
  if (input.flowId !== undefined) payload.flowId = input.flowId;
  if (input.flowRunId !== undefined) payload.flowRunId = input.flowRunId;
  if (input.tags !== undefined) payload.tags = input.tags;

  return Object.keys(payload).length > 0 ? payload : undefined;
}
