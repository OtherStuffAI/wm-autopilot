import type { AgentRuntimeStatus } from "../types/agent-status";
import type { SessionApiContext } from "../server/session-api-routes";
import type { PipelineStatus, PipelineStore, PipelineStepRecord } from "./pipeline-store";

export const PIPELINE_AGENT_SUCCESS_GRACE_MS = 60_000;
const PIPELINE_AGENT_GRACE_POLL_MS = 250;
const REQUIRED_STABLE_OBSERVATIONS = 2;

interface FinalizationClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

interface FinalizePipelineAgentSessionInput {
  ctx: SessionApiContext;
  store: PipelineStore;
  runId: string;
  stepId: string;
  sessionId: string;
  callbackStatus: PipelineStatus | null;
  graceMs?: number;
  pollMs?: number;
  clock?: FinalizationClock;
}

type GraceOutcome = "settled" | "expired" | "interrupted" | "session_missing";

const systemClock: FinalizationClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function finalizePipelineAgentSession(input: FinalizePipelineAgentSessionInput): Promise<void> {
  const clock = input.clock ?? systemClock;
  const graceMs = input.graceMs ?? PIPELINE_AGENT_SUCCESS_GRACE_MS;
  const pollMs = input.pollMs ?? PIPELINE_AGENT_GRACE_POLL_MS;

  if (input.callbackStatus === "ok") {
    const grace = await waitForStableAgentTurn({ ...input, clock, graceMs, pollMs });
    const event = graceEvent(grace.outcome);
    input.store.addEvent({
      runId: input.runId,
      stepId: input.stepId,
      level: event.level,
      type: event.type,
      message: grace.outcome,
      data: {
        sessionId: input.sessionId,
        graceMs,
        elapsedMs: grace.elapsedMs,
        observations: grace.observations,
      },
    });

    if (grace.outcome === "settled" || grace.outcome === "expired") {
      try {
        await input.ctx.syncSessionMessages(input.sessionId, true);
        input.store.addEvent({
          runId: input.runId,
          stepId: input.stepId,
          level: "info",
          type: "agent_session_final_sync_completed",
          message: input.sessionId,
          data: { graceOutcome: grace.outcome },
        });
      } catch (error) {
        input.store.addEvent({
          runId: input.runId,
          stepId: input.stepId,
          level: "warn",
          type: "agent_session_final_sync_failed",
          message: error instanceof Error ? error.message : String(error),
          data: { sessionId: input.sessionId, graceOutcome: grace.outcome },
        });
      }
    }
  }

  input.ctx.manager.updateSessionMetadata?.(input.sessionId, { nextAction: "stop" });
  const stopped = await input.ctx.manager.stopSession(input.sessionId);
  if (stopped) input.ctx.scheduleSessionArchive(input.sessionId, input.ctx.manager);
}

function graceEvent(outcome: GraceOutcome): {
  level: "info" | "warn";
  type: string;
} {
  if (outcome === "settled") return { level: "info", type: "agent_session_grace_completed" };
  if (outcome === "expired") return { level: "warn", type: "agent_session_grace_expired" };
  if (outcome === "session_missing") return { level: "warn", type: "agent_session_grace_session_missing" };
  return { level: "info", type: "agent_session_grace_interrupted" };
}

async function waitForStableAgentTurn(input: FinalizePipelineAgentSessionInput & {
  clock: FinalizationClock;
  graceMs: number;
  pollMs: number;
}): Promise<{ outcome: GraceOutcome; elapsedMs: number; observations: number }> {
  const startedAt = input.clock.now();
  const deadline = startedAt + input.graceMs;
  let stableObservations = 0;
  let observations = 0;

  while (input.clock.now() < deadline) {
    const run = input.store.getRun(input.runId);
    const step = input.store.getStep(input.stepId);
    if (run?.status !== "running" || step?.status !== "ok") {
      return { outcome: "interrupted", elapsedMs: input.clock.now() - startedAt, observations };
    }

    const session = input.ctx.manager.getSession(input.sessionId);
    if (!session || session.status !== "running") {
      return { outcome: "session_missing", elapsedMs: input.clock.now() - startedAt, observations };
    }

    const status = await readRuntimeStatus(input.ctx, input.sessionId, deadline - input.clock.now());
    observations += 1;
    stableObservations = status === "stable" ? stableObservations + 1 : 0;
    if (stableObservations >= REQUIRED_STABLE_OBSERVATIONS) {
      return { outcome: "settled", elapsedMs: input.clock.now() - startedAt, observations };
    }

    const remainingMs = deadline - input.clock.now();
    if (remainingMs <= 0) break;
    await input.clock.sleep(Math.min(input.pollMs, remainingMs));
  }

  return { outcome: "expired", elapsedMs: input.clock.now() - startedAt, observations };
}

async function readRuntimeStatus(
  ctx: SessionApiContext,
  sessionId: string,
  remainingMs: number,
): Promise<AgentRuntimeStatus | null> {
  const adapter = ctx.manager.getAdapter(sessionId);
  if (!adapter) return ctx.manager.getSession(sessionId)?.agentRuntimeStatus ?? null;
  const timeoutMs = Math.max(1, Math.min(750, remainingMs));
  return await adapter.fetchStatus(timeoutMs).catch(() => null);
}

/** A callback may have arrived while this runner was down but its agent is still live. */
export async function finalizeRecoveredPipelineAgentSession(input: {
  ctx: SessionApiContext; store: PipelineStore; runId: string; step: PipelineStepRecord;
}): Promise<void> {
  const sessionId = input.step.wingmanSessionId;
  if (!sessionId || !input.ctx.manager.getSession(sessionId)) return;
  await finalizePipelineAgentSession({ ...input, stepId: input.step.id, sessionId, callbackStatus: input.step.status });
}
