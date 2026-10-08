import { featureFlagStore, resolveFeatureFlagEffectiveState } from "../storage/feature-flag-store";
import type { SessionMetadata } from "../sessions/session-metadata";

export const SESSION_APPROVAL_POLICY_FLAG = "session_provider_auto_approve";
export const SUPPORTED_APPROVAL_TRANSPORTS = new Set(["claude-sdk", "codex-acp"]);
const listeners = new Set<() => void>();

export function sessionApprovalConfigured(metadata: Pick<SessionMetadata, "providerApprovalPolicy" | "agentTransport">): boolean {
  return metadata.providerApprovalPolicy !== undefined && SUPPORTED_APPROVAL_TRANSPORTS.has(metadata.agentTransport ?? "");
}

export function sessionApprovalEnabled(metadata: Pick<SessionMetadata, "providerApprovalPolicy" | "agentTransport">,
  isAdmin: boolean, state = featureFlagStore.getFlag(SESSION_APPROVAL_POLICY_FLAG)?.state ?? "off"): boolean {
  return metadata.providerApprovalPolicy === "always" && sessionApprovalConfigured(metadata)
    && resolveFeatureFlagEffectiveState(state, isAdmin) === "on";
}

export function subscribeSessionApprovalChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called after durable flag/session updates; no provider transport is replaced. */
export function notifySessionApprovalChanges(): void {
  for (const listener of listeners) listener();
}

export const UNATTENDED_QUESTION_GUIDANCE = "Session provider consent is enabled, but this is a question, not tool consent. "
  + "For optional implementation choices, use supplied recommended defaults or your judgment and record each choice and reason in your response. "
  + "Do not ask again for optional choices. If essential information or explicit human authorization is missing, report the blocker and stop; "
  + "do not invent information, approvals, credentials or authorization. This policy grants no broker/Tower capabilities and no restart authority.";
