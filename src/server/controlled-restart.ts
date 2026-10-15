import { readFile, writeFile } from "node:fs/promises";
import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import type { AgentType } from "../config";
import type { MessageStore } from "../storage/message-store";
import type { PromptQueueStore } from "../storage/prompt-queue-store";
import type { SessionDispatchStore } from "../session-dispatch/session-dispatch-store";
import type { DirectChatTurnStore } from "../agent-chat/direct-chat-turn-store";
import { createRestartReplacement } from "../sessions/restart-session-policy";
import {
  assessRestartRecovery,
  type RestartRecoveryClassification,
} from "../sessions/restart-recovery-eligibility";
import { restartDrainGate } from "../agents/session-admission";
import {
  type WarmRestartMarker,
  writeWarmRestartMarker,
} from "./bootstrap/warm-restart";

export type ControlledRestartClassification = RestartRecoveryClassification;

export type ControlledRestartPhaseName =
  | "requested"
  | "draining"
  | "checkpointed"
  | "stopping"
  | "restart-requested"
  | "recovering"
  | "complete";

export interface ControlledRestartPhase {
  phase: ControlledRestartPhaseName;
  startedAt: string;
  completedAt?: string;
  outcome: "pending" | "succeeded" | "partial" | "failed";
  detail?: string;
}

export interface ControlledRestartSession {
  id: string;
  classification: ControlledRestartClassification;
  eligible: boolean;
  forced: boolean;
  queueCount: number;
  recoveryStatus: "pending" | "restored" | "failed" | "not-eligible";
  replacementSessionId?: string;
  failure?: string;
}

export interface ControlledRestartOperation {
  version: 1;
  operationId: string;
  requesterNpub: string;
  createdAt: string;
  updatedAt: string;
  status: "requested" | "draining" | "checkpointed" | "restart-requested" | "recovering" | "complete" | "partial" | "failed";
  gracePeriodMs: number;
  phases: ControlledRestartPhase[];
  sessions: ControlledRestartSession[];
  counts: Record<ControlledRestartClassification, number> & { eligible: number; forced: number };
  affectedSessionIds: string[];
  forcedSessionIds: string[];
  failure?: { phase: string; message: string };
  initiator: {
    sessionId: string | null;
    reporting: "durable-direct-status";
    detail: string;
  };
}

export { restartDrainGate };

const safeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|cookie|token|secret|password|nsec)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 500);
};

export async function loadControlledRestartOperation(path: string): Promise<ControlledRestartOperation | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ControlledRestartOperation;
    return parsed?.version === 1 && typeof parsed.operationId === "string" ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function persist(path: string, operation: ControlledRestartOperation): Promise<void> {
  operation.updatedAt = new Date().toISOString();
  await writeFile(path, `${JSON.stringify(operation, null, 2)}\n`, "utf8");
}

function phase(operation: ControlledRestartOperation, name: ControlledRestartPhaseName): ControlledRestartPhase {
  const current = operation.phases.find((entry) => entry.phase === name);
  if (current) return current;
  const created: ControlledRestartPhase = { phase: name, startedAt: new Date().toISOString(), outcome: "pending" };
  operation.phases.push(created);
  return created;
}

function finishPhase(
  operation: ControlledRestartOperation,
  name: ControlledRestartPhaseName,
  outcome: ControlledRestartPhase["outcome"],
  detail?: string,
): void {
  const entry = phase(operation, name);
  entry.completedAt = new Date().toISOString();
  entry.outcome = outcome;
  if (detail) entry.detail = detail;
}

function classifySessions(
  manager: ProcessManager,
  store: MessageStore,
  queue: PromptQueueStore,
  directChatTurns: Pick<DirectChatTurnStore, "hasRecoverableSessionTurn">,
  dispatches: Pick<SessionDispatchStore, "hasRecoveryWork">,
  inFlightIds: ReadonlySet<string>,
): ControlledRestartSession[] {
  const live = manager.listSessions();
  const liveIds = new Set(live.map((session) => session.id));
  const rows = live.map((session) => {
    const queueCount = queue.getQueueCount(session.id);
    const { classification, eligible } = assessRestartRecovery(session, {
      queueCount,
      queueDispatchInFlight: inFlightIds.has(session.id),
      hasDirectChatTurn: directChatTurns.hasRecoverableSessionTurn(session.id),
      hasSupervisedWork: dispatches.hasRecoveryWork(session.id),
    });
    return { id: session.id, classification, eligible, forced: false, queueCount,
      recoveryStatus: eligible ? "pending" as const : "not-eligible" as const };
  });
  for (const record of store.listSessions()) {
    if (!liveIds.has(record.id)) {
      rows.push({ id: record.id, classification: "terminal", eligible: false, forced: false,
        queueCount: queue.getQueueCount(record.id), recoveryStatus: "not-eligible" });
    }
  }
  return rows;
}

function countsFor(sessions: ControlledRestartSession[]): ControlledRestartOperation["counts"] {
  const counts: ControlledRestartOperation["counts"] = {
    "active-in-flight": 0, queued: 0, "agent-direct": 0, supervised: 0,
    scheduled: 0, "user-persistent": 0, "settled-auto": 0, terminal: 0,
    eligible: 0, forced: 0,
  };
  for (const session of sessions) {
    counts[session.classification] += 1;
    if (session.eligible) counts.eligible += 1;
    if (session.forced) counts.forced += 1;
  }
  return counts;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ControlledRestartRequest {
  manager: ProcessManager;
  messageStore: MessageStore;
  promptQueueStore: PromptQueueStore;
  sessionDispatchStore: SessionDispatchStore;
  directChatTurnStore: Pick<DirectChatTurnStore, "hasRecoverableSessionTurn">;
  queueDispatchInFlight: ReadonlySet<string>;
  operationPath: string;
  markerPath: string;
  requesterNpub: string;
  gracePeriodMs: number;
  initiatingSessionId?: string | null;
  isAgentType: (agent: string) => agent is AgentType;
  launch: (marker: WarmRestartMarker) => Promise<Response>;
  preflight?: () => Promise<void>;
  now?: () => Date;
}

export async function requestControlledRestart(input: ControlledRestartRequest): Promise<Response> {
  try {
    await input.preflight?.();
  } catch (error) {
    return Response.json({ error: `Restart is unavailable: ${safeError(error)}` }, { status: 500 });
  }
  const now = input.now ?? (() => new Date());
  const operationId = crypto.randomUUID();
  restartDrainGate.enter(operationId);
  const sourceSessions = input.manager.listSessions();
  const sessions = classifySessions(
    input.manager,
    input.messageStore,
    input.promptQueueStore,
    input.directChatTurnStore,
    input.sessionDispatchStore,
    input.queueDispatchInFlight,
  );
  const createdAt = now().toISOString();
  const operation: ControlledRestartOperation = {
    version: 1, operationId, requesterNpub: input.requesterNpub, createdAt, updatedAt: createdAt,
    status: "requested", gracePeriodMs: input.gracePeriodMs,
    phases: [{ phase: "requested", startedAt: createdAt, completedAt: createdAt, outcome: "succeeded" }],
    sessions, counts: countsFor(sessions), affectedSessionIds: sessions.filter((entry) => entry.eligible).map((entry) => entry.id),
    forcedSessionIds: [],
    initiator: {
      sessionId: input.initiatingSessionId ?? null,
      reporting: "durable-direct-status",
      detail: input.initiatingSessionId
        ? "The initiating session is checkpointed with all eligible sessions; final reporting resumes from the durable direct status route."
        : "The browser request has no Autopilot manager session binding; final reporting resumes from the durable direct status route.",
    },
  };

  try {
    await persist(input.operationPath, operation);
  } catch (error) {
    restartDrainGate.leave(operationId);
    return Response.json({ error: `Failed to persist controlled restart checkpoint: ${safeError(error)}` }, { status: 500 });
  }

  operation.status = "draining";
  phase(operation, "draining");
  await persist(input.operationPath, operation);
  const deadline = Date.now() + Math.max(0, input.gracePeriodMs);
  while (Date.now() < deadline) {
    const active = operation.sessions.filter((entry) => entry.eligible).filter((entry) => {
      const current = input.manager.getSession(entry.id);
      return current?.agentRuntimeStatus === "running" || input.queueDispatchInFlight.has(entry.id);
    });
    if (active.length === 0) break;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  const forced = operation.sessions.filter((entry) => entry.eligible).filter((entry) => {
    const current = input.manager.getSession(entry.id);
    return current?.agentRuntimeStatus === "running" || input.queueDispatchInFlight.has(entry.id);
  });
  for (const entry of forced) entry.forced = true;
  operation.forcedSessionIds = forced.map((entry) => entry.id);
  operation.counts = countsFor(operation.sessions);
  finishPhase(operation, "draining", forced.length ? "partial" : "succeeded",
    forced.length ? `${forced.length} in-flight session(s) exceeded the grace period and require forced termination.` : undefined);

  const marker: WarmRestartMarker = {
    createdAt, sessionIds: operation.affectedSessionIds, reason: "flightdeck-controlled-restart",
    version: 4, mode: "resume-or-fresh", requestedBy: input.requesterNpub,
    status: "checkpointed", operationId,
  };
  try {
    await writeWarmRestartMarker(input.markerPath, marker);
    operation.status = "checkpointed";
    finishPhase(operation, "checkpointed", "succeeded");
    await persist(input.operationPath, operation);
  } catch (error) {
    operation.status = "failed";
    operation.failure = { phase: "checkpointed", message: safeError(error) };
    finishPhase(operation, "checkpointed", "failed", operation.failure.message);
    await persist(input.operationPath, operation).catch(() => undefined);
    restartDrainGate.leave(operationId);
    return Response.json({ error: "Failed to persist restart marker", operation }, { status: 500 });
  }

  phase(operation, "stopping");
  await persist(input.operationPath, operation);
  const stopFailures: string[] = [];
  const stoppedIds: string[] = [];
  for (const source of sourceSessions) {
    const entry = operation.sessions.find((candidate) => candidate.id === source.id);
    try { await input.manager.stopSession(source.id); stoppedIds.push(source.id); }
    catch (error) {
      if (entry) entry.failure = safeError(error);
      stopFailures.push(source.id);
    }
  }
  finishPhase(operation, "stopping", stopFailures.length ? "partial" : "succeeded",
    stopFailures.length ? `Failed to stop ${stopFailures.length} session(s).` : undefined);
  if (stopFailures.length) {
    restartDrainGate.leave(operationId);
    const rollbackFailures = await restoreAfterRejectedRestart(
      sourceSessions,
      stoppedIds,
      operation.affectedSessionIds,
      input,
    );
    operation.status = "failed";
    operation.failure = { phase: "stopping", message: `Failed to stop sessions: ${stopFailures.join(", ")}; rollback failures: ${rollbackFailures.join(", ") || "none"}` };
    await persist(input.operationPath, operation);
    return Response.json({ error: operation.failure.message, operation }, { status: 500 });
  }

  try {
    const response = await input.launch(marker);
    if (!response.ok) {
      const responseBody = await response.clone().json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof responseBody?.error === "string" ? responseBody.error : `Supervisor rejected restart (${response.status})`);
    }
    operation.status = "restart-requested";
    finishPhase(operation, "restart-requested", "succeeded");
    await persist(input.operationPath, operation);
    return Response.json({ status: operation.status, operationId, operation }, { status: 202 });
  } catch (error) {
    restartDrainGate.leave(operationId);
    const rollbackFailures = await restoreAfterRejectedRestart(
      sourceSessions,
      stoppedIds,
      operation.affectedSessionIds,
      input,
    );
    operation.status = "failed";
    operation.failure = { phase: "restart-requested", message: `${safeError(error)}; rollback failures: ${rollbackFailures.join(", ") || "none"}` };
    finishPhase(operation, "restart-requested", "failed", operation.failure.message);
    await persist(input.operationPath, operation);
    return Response.json({ error: `Failed to launch restart: ${operation.failure.message}`, operation }, { status: 500 });
  }
}

async function restoreAfterRejectedRestart(
  sourceSessions: SessionSnapshot[],
  stoppedIds: string[],
  recoveryEligibleIds: string[],
  input: ControlledRestartRequest,
): Promise<string[]> {
  const stopped = new Set(stoppedIds);
  const recoveryEligible = new Set(recoveryEligibleIds);
  const failures: string[] = [];
  for (const source of sourceSessions) {
    if (!stopped.has(source.id) || !recoveryEligible.has(source.id)) continue;
    try {
      const replacement = await createRestartReplacement(input.manager, source, input.isAgentType, input.requesterNpub);
      input.promptQueueStore.rebindSession(source.id, replacement.sessionId);
      input.sessionDispatchStore.rebindSession(source.id, replacement.sessionId);
    } catch {
      failures.push(source.id);
    }
  }
  return failures;
}

export async function recordControlledRestartRecovery(
  operationPath: string,
  outcome: { failed: string[]; resumedSessions?: Array<{ sourceSessionId: string; sessionId: string }>; freshSessions?: Array<{ sourceSessionId: string; sessionId: string }> } | null,
): Promise<ControlledRestartOperation | null> {
  const operation = await loadControlledRestartOperation(operationPath);
  if (!operation || operation.status === "complete" || operation.status === "partial") return operation;
  operation.status = "recovering";
  phase(operation, "recovering");
  const replacements = new Map([
    ...(outcome?.resumedSessions ?? []).map((entry) => [entry.sourceSessionId, entry.sessionId] as const),
    ...(outcome?.freshSessions ?? []).map((entry) => [entry.sourceSessionId, entry.sessionId] as const),
  ]);
  const failed = new Set(outcome?.failed ?? operation.affectedSessionIds);
  for (const session of operation.sessions) {
    if (!session.eligible || session.recoveryStatus === "restored") continue;
    const replacement = replacements.get(session.id);
    if (replacement) {
      session.recoveryStatus = "restored";
      session.replacementSessionId = replacement;
      delete session.failure;
    } else if (failed.has(session.id)) {
      session.recoveryStatus = "failed";
      session.failure = "Session recovery failed; inspect server logs for the non-secret diagnostic.";
    }
  }
  const recoveryFailures = operation.sessions.filter((entry) => entry.recoveryStatus === "failed");
  operation.status = recoveryFailures.length || operation.forcedSessionIds.length ? "partial" : "complete";
  finishPhase(operation, "recovering", recoveryFailures.length ? "partial" : "succeeded");
  finishPhase(operation, "complete", operation.status === "complete" ? "succeeded" : "partial",
    recoveryFailures.length ? `${recoveryFailures.length} session(s) failed recovery.` : undefined);
  await persist(operationPath, operation);
  return operation;
}
