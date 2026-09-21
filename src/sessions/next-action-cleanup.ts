import type { PromptReadiness } from "../agents/agent-adapter";
import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import type { AgentType } from "../config";
import {
  assessAutosessionCleanupCandidate,
  isAutomaticallyStartedSession,
  type AutosessionCleanupDecision,
} from "./autosession-cleanup";

export const SCHEDULED_CLEANUP_STALE_MINUTES = 60;

type NextActionCleanupSkipReason = "protected" | "user-started" | "not-stale" | "missing-last-updated-at"
  | "not-ready" | "missing";

type NextActionCleanupDetail = {
  id: string;
  agent: AgentType;
  name: string;
  reason: "next-action-stop" | "stale";
  stopped: boolean;
  archiveScheduled: boolean;
  error?: string;
};

export type NextActionCleanupResult = {
  timestamp: string;
  checked: number;
  matched: number;
  stopped: number;
  archiveScheduled: number;
  failed: number;
  details: NextActionCleanupDetail[];
  skipped: Array<{ id: string; reason: NextActionCleanupSkipReason }>;
};

export interface NextActionCleanupDeps {
  manager: ProcessManager;
  scheduleArchive: (sessionId: string) => void;
  isSessionProtected?: (sessionId: string) => boolean;
  getLastUpdatedAt?: (sessionId: string) => string | null;
  getReadiness?: (session: SessionSnapshot) => Promise<PromptReadiness>;
  now?: () => number;
  currentSessionId?: string;
}

function activityDecision(deps: NextActionCleanupDeps, session: SessionSnapshot) {
  return assessAutosessionCleanupCandidate(
    { ...session, lastUpdatedAt: deps.getLastUpdatedAt?.(session.id) ?? null },
    { currentSessionId: deps.currentSessionId ?? "", nowMs: deps.now?.() ?? Date.now(), staleMinutes: SCHEDULED_CLEANUP_STALE_MINUTES },
  );
}

function cleanupSkipReason(reason: AutosessionCleanupDecision["reason"]): NextActionCleanupSkipReason {
  if (reason === "self") return "protected";
  if (reason === "eligible") throw new Error("Eligible cleanup decisions cannot be skipped");
  return reason;
}

export async function cleanupStopNextActionSessions(deps: NextActionCleanupDeps): Promise<NextActionCleanupResult> {
  const sessions = deps.manager.listSessions();
  const details: NextActionCleanupDetail[] = [];
  const skipped: NextActionCleanupResult["skipped"] = [];
  let matched = 0;
  let stopped = 0;
  let archiveScheduled = 0;
  let failed = 0;

  for (const listedSession of sessions) {
    if (deps.isSessionProtected?.(listedSession.id) || listedSession.id === deps.currentSessionId) {
      skipped.push({ id: listedSession.id, reason: "protected" });
      continue;
    }
    if (!isAutomaticallyStartedSession(listedSession)) {
      skipped.push({ id: listedSession.id, reason: "user-started" });
      continue;
    }

    const immediate = listedSession.metadata?.nextAction === "stop";
    let session = listedSession;
    if (!immediate) {
      const decision = activityDecision(deps, session);
      if (!decision.eligible) {
        skipped.push({ id: session.id, reason: cleanupSkipReason(decision.reason) });
        continue;
      }
      if (!deps.getReadiness || (await deps.getReadiness(session)).state !== "ready") {
        skipped.push({ id: session.id, reason: "not-ready" });
        continue;
      }
      const current = deps.manager.getSession(session.id);
      if (!current) {
        skipped.push({ id: session.id, reason: "missing" });
        continue;
      }
      session = current;
      if (deps.isSessionProtected?.(session.id) || session.id === deps.currentSessionId) {
        skipped.push({ id: session.id, reason: "protected" });
        continue;
      }
      const currentDecision = activityDecision(deps, session);
      if (!currentDecision.eligible) {
        skipped.push({ id: session.id, reason: cleanupSkipReason(currentDecision.reason) });
        continue;
      }
      if ((await deps.getReadiness(session)).state !== "ready") {
        skipped.push({ id: session.id, reason: "not-ready" });
        continue;
      }
    }

    matched += 1;
    const detail: NextActionCleanupDetail = {
      id: session.id, agent: session.agent, name: session.name,
      reason: immediate ? "next-action-stop" : "stale", stopped: false, archiveScheduled: false,
    };
    try {
      await deps.manager.stopSession(session.id);
      detail.stopped = true;
      stopped += 1;
      deps.scheduleArchive(session.id);
      detail.archiveScheduled = true;
      archiveScheduled += 1;
    } catch (error) {
      detail.error = error instanceof Error ? error.message : String(error);
      failed += 1;
    }
    details.push(detail);
  }

  return {
    timestamp: new Date(deps.now?.() ?? Date.now()).toISOString(), checked: sessions.length, matched,
    stopped, archiveScheduled, failed, details, skipped,
  };
}
