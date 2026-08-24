/**
 * Night Watch Engine
 *
 * Replaces the old OpenRouter supervisor loop with a simple recurring
 * check-in timer. While enabled, Night Watch sends "Any progress?"
 * every 5 minutes for the session.
 */

import { buildAgentUrl } from "../agents/agent-client";
import type { SessionSnapshot } from "../agents/process-manager";
import type { SessionMetadataInput } from "../sessions/session-metadata";
import type { FeatureFlagRecord } from "../storage/feature-flag-store";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import type { NightWatchStore } from "./nightwatch-store";
import {
  NIGHTWATCH_CHECK_IN_PROMPT,
  NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
  NIGHTWATCH_DEFAULT_MODEL,
  NIGHTWATCH_DEFAULT_PROMPT,
  NIGHTWATCH_FEATURE_FLAG_KEY,
  NIGHTWATCH_MAX_INTERVAL_MINUTES,
  NIGHTWATCH_MAX_CYCLE_OPTIONS,
  NIGHTWATCH_MIN_INTERVAL_MINUTES,
  NIGHTWATCH_MODELS,
  getNightWatchRetryPromptAt,
} from "./nightwatch-constants";

export {
  NIGHTWATCH_CHECK_IN_PROMPT,
  NIGHTWATCH_DEFAULT_INTERVAL_MINUTES,
  NIGHTWATCH_DEFAULT_MODEL,
  NIGHTWATCH_DEFAULT_PROMPT,
  NIGHTWATCH_FEATURE_FLAG_KEY,
  NIGHTWATCH_MAX_INTERVAL_MINUTES,
  NIGHTWATCH_MAX_CYCLE_OPTIONS,
  NIGHTWATCH_MIN_INTERVAL_MINUTES,
  NIGHTWATCH_MODELS,
};

interface FeatureFlagStore {
  getFlag(key: string): FeatureFlagRecord | null;
}

export interface NightWatchDeps {
  store: NightWatchStore;
  featureFlagStore: FeatureFlagStore;
  agentHost: string;
  getSession: (sessionId: string) => SessionSnapshot | null;
  updateSessionMetadata?: (
    sessionId: string,
    metadata: SessionMetadataInput,
  ) => SessionSnapshot | null;
}

const nightwatchInFlight = new Set<string>();

function isNightWatchFeatureEnabled(deps: NightWatchDeps): boolean {
  const flag = deps.featureFlagStore.getFlag(NIGHTWATCH_FEATURE_FLAG_KEY);
  return Boolean(flag && flag.state !== "off");
}

function getPromptAtMs(promptAt: string | null): number | null {
  if (!promptAt) return null;
  const promptAtMs = Date.parse(promptAt);
  return Number.isFinite(promptAtMs) ? promptAtMs : null;
}

function buildCheckInSummary(sessionName: string | null, cycleCount: number, prompt: string): string {
  const label = sessionName ?? "session";
  const compactPrompt = prompt.replace(/\s+/g, " ").trim();
  const preview =
    compactPrompt.length > 80 ? `${compactPrompt.slice(0, 77)}...` : compactPrompt;
  return `Sent "${preview}" to ${label} (${cycleCount} check-ins).`;
}

function buildHookReasoning(action: string, detail?: string): string {
  return detail ? `Night Watch hook "${action}" fired. ${detail}` : `Night Watch hook "${action}" fired.`;
}

function renderHookTemplate(template: string, replacements: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey) => {
    const key = typeof rawKey === "string" ? rawKey : "";
    return replacements[key] ?? "";
  });
}

function buildReflectionPrompt(session: SessionSnapshot): string {
  const goal = typeof session.metadata?.goal === "string" ? session.metadata.goal.trim() : "";
  const payload =
    typeof session.metadata?.nextActionPayload === "string"
      ? session.metadata.nextActionPayload.trim()
      : "";
  const template =
    typeof session.metadata?.nextActionTemplate === "string"
      ? session.metadata.nextActionTemplate.trim()
      : "";
  const sessionName = typeof session.name === "string" ? session.name.trim() : "";
  const workingDirectory =
    typeof session.workingDirectory === "string" ? session.workingDirectory.trim() : "";

  if (template) {
    const rendered = renderHookTemplate(template, {
      goal,
      nextActionPayload: payload,
      payload,
      sessionName,
      workingDirectory,
    }).trim();
    if (rendered) {
      return rendered;
    }
  }

  const sections = [
    "Night Watch reflection check-in.",
    goal
      ? `Current goal: ${goal}`
      : "Current goal: not set. First state the working goal you are following right now.",
    "Briefly assess progress, identify the main blocker or uncertainty, and name the next concrete action you will take.",
  ];
  if (payload) {
    sections.push(`Additional context: ${payload}`);
  }
  return sections.join("\n\n");
}

function disableNightWatchWithReport(
  session: SessionSnapshot,
  deps: NightWatchDeps,
  report: {
    status: "complete" | "monitor";
    summary: string;
    reasoning: string;
    cycleCount: number;
  },
): void {
  deps.store.disableSession(session.id);
  deps.store.addReport({
    sessionId: session.id,
    sessionName: session.name ?? null,
    workingDirectory: session.workingDirectory ?? null,
    status: report.status,
    summary: report.summary,
    reasoning: report.reasoning,
    cycleCount: report.cycleCount,
  });
}

async function sendNightWatchPrompt(
  session: SessionSnapshot,
  prompt: string,
  deps: NightWatchDeps,
): Promise<{ ok: boolean; message: string }> {
  return deliverSessionAgentMessage({
    sessionId: session.id,
    agentHost: deps.agentHost,
    buildAgentUrl,
    agent: session.agent,
    port: session.port,
    content: prompt,
    type: "user",
    pm2Name: session.pm2Name,
  });
}

export async function maybeTriggerNightWatch(
  session: SessionSnapshot | null,
  deps: NightWatchDeps,
): Promise<void> {
  if (!session) return;
  if (!isNightWatchFeatureEnabled(deps)) return;

  const sessionState = deps.store.getSessionState(session.id);
  if (!sessionState?.enabled) return;
  if (session.status !== "running" || session.agentRuntimeStatus !== "stable") return;
  if (nightwatchInFlight.has(session.id)) return;

  if (!sessionState.promptAt) {
    deps.store.scheduleNextPrompt(session.id);
    return;
  }

  const promptAtMs = getPromptAtMs(sessionState.promptAt);
  if (promptAtMs == null) {
    deps.store.scheduleNextPrompt(session.id);
    return;
  }

  if (promptAtMs > Date.now()) {
    return;
  }

  nightwatchInFlight.add(session.id);
  try {
    const currentSession = deps.getSession(session.id) ?? session;
    const nextAction = currentSession.metadata?.nextAction;
    if (nextAction === "stop") {
      disableNightWatchWithReport(currentSession, deps, {
        status: "complete",
        summary: "Night Watch disabled by session metadata hook.",
        reasoning: buildHookReasoning("stop"),
        cycleCount: sessionState.cycleCount,
      });
      return;
    }
    if (nextAction === "restart") {
      disableNightWatchWithReport(currentSession, deps, {
        status: "monitor",
        summary:
          "Session requested restart, but restart orchestration is not implemented in this slice. Night Watch was disabled to avoid a retry loop.",
        reasoning: buildHookReasoning(
          "restart",
          "Leave the metadata in place so the next slice can resume explicit restart handling.",
        ),
        cycleCount: sessionState.cycleCount,
      });
      return;
    }

    const prompt =
      nextAction === "reflect"
        ? buildReflectionPrompt(currentSession)
        : sessionState.prompt;
    const willContinue = sessionState.cycleCount + 1 < sessionState.maxCycles;
    const result = await sendNightWatchPrompt(currentSession, prompt, deps);

    if (!result.ok) {
      deps.store.postponePrompt(session.id, getNightWatchRetryPromptAt());
      console.warn(
        `[nightwatch] Failed to send check-in for session ${session.id}: ${result.message}`,
      );
      return;
    }

    const persistedSession = currentSession;
    const cycleCount = deps.store.recordPromptSent(session.id, willContinue);
    deps.store.addReport({
      sessionId: session.id,
      sessionName: persistedSession.name ?? null,
      workingDirectory: persistedSession.workingDirectory ?? null,
      status: willContinue ? "continue" : "complete",
      summary: buildCheckInSummary(persistedSession.name ?? null, cycleCount, prompt),
      reasoning:
        `Night Watch timer fired after ${sessionState.intervalMinutes} minute` +
        `${sessionState.intervalMinutes === 1 ? "" : "s"}.` +
        (nextAction === "reflect" ? ` ${buildHookReasoning("reflect")}` : ""),
      cycleCount,
    });
  } finally {
    nightwatchInFlight.delete(session.id);
  }
}
