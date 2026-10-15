import type { SessionSnapshot } from "../agents/process-manager";
import { isAutomaticallyStartedSession } from "./autosession-cleanup";

export type RestartRecoveryClassification =
  | "active-in-flight"
  | "queued"
  | "agent-direct"
  | "supervised"
  | "scheduled"
  | "user-persistent"
  | "settled-auto"
  | "terminal";

export interface RestartRecoveryEvidence {
  queueCount: number;
  queueDispatchInFlight: boolean;
  hasDirectChatTurn: boolean;
  hasSupervisedWork: boolean;
}

export interface RestartRecoveryDecision {
  classification: RestartRecoveryClassification;
  eligible: boolean;
}

/**
 * Restart persistence follows durable work, not advisory next-action metadata.
 * In particular, a stale `reflect` value cannot keep a settled auto-session
 * alive after its accepted work and delivery have reached terminal states.
 */
export function assessRestartRecovery(
  session: SessionSnapshot,
  evidence: RestartRecoveryEvidence,
): RestartRecoveryDecision {
  if (session.status === "stopped" || session.status === "error") {
    return { classification: "terminal", eligible: false };
  }
  if (session.origin?.type === "scheduler") {
    return { classification: "scheduled", eligible: true };
  }
  if (
    session.status === "starting"
    || session.agentRuntimeStatus === "running"
    || evidence.queueDispatchInFlight
  ) {
    return { classification: "active-in-flight", eligible: true };
  }
  if (evidence.queueCount > 0) {
    return { classification: "queued", eligible: true };
  }
  if (evidence.hasDirectChatTurn) {
    return { classification: "agent-direct", eligible: true };
  }
  if (evidence.hasSupervisedWork) {
    return { classification: "supervised", eligible: true };
  }
  if (!isAutomaticallyStartedSession(session)) {
    return { classification: "user-persistent", eligible: true };
  }
  return { classification: "settled-auto", eligible: false };
}
