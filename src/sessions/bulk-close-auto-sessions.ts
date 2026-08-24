import type { PromptReadiness } from "../agents/agent-adapter";
import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import {
  assessAutosessionCleanupCandidate,
  type AutosessionCleanupDecision,
} from "./autosession-cleanup";

export const BULK_CLOSE_AUTO_SESSION_MINUTES = 21;

type BulkCloseSkipReason = AutosessionCleanupDecision["reason"] | "not-stable" | "missing";

export interface BulkCloseAutoSessionsResult {
  checked: number;
  eligible: number;
  closed: string[];
  skipped: Array<{ id: string; reason: BulkCloseSkipReason }>;
  failed: Array<{ id: string; error: string }>;
}

export async function closeStaleStableAutoSessions(options: {
  sessions: SessionSnapshot[];
  manager: Pick<ProcessManager, "getSession" | "stopSession">;
  now: () => number;
  getLastUpdatedAt: (sessionId: string) => string | null;
  getReadiness: (session: SessionSnapshot) => Promise<PromptReadiness>;
  onClosed: (sessionId: string) => void;
}): Promise<BulkCloseAutoSessionsResult> {
  const result: BulkCloseAutoSessionsResult = {
    checked: options.sessions.length,
    eligible: 0,
    closed: [],
    skipped: [],
    failed: [],
  };

  for (const listedSession of options.sessions) {
    const id = listedSession.id;
    try {
      const currentSession = options.manager.getSession(id);
      if (!currentSession) {
        result.skipped.push({ id, reason: "missing" });
        continue;
      }

      const decision = assessAutosessionCleanupCandidate(
        { ...currentSession, lastUpdatedAt: options.getLastUpdatedAt(id) },
        {
          currentSessionId: "",
          nowMs: options.now(),
          staleMinutes: BULK_CLOSE_AUTO_SESSION_MINUTES,
        },
      );
      if (!decision.eligible) {
        result.skipped.push({ id, reason: decision.reason });
        continue;
      }

      const readiness = await options.getReadiness(currentSession);
      if (readiness.state !== "ready") {
        result.skipped.push({ id, reason: "not-stable" });
        continue;
      }

      // Re-read classification and age after the async readiness check, immediately
      // before stopping, so a newly active or recently updated session is preserved.
      const mutationSession = options.manager.getSession(id);
      if (!mutationSession) {
        result.skipped.push({ id, reason: "missing" });
        continue;
      }
      const mutationDecision = assessAutosessionCleanupCandidate(
        { ...mutationSession, lastUpdatedAt: options.getLastUpdatedAt(id) },
        {
          currentSessionId: "",
          nowMs: options.now(),
          staleMinutes: BULK_CLOSE_AUTO_SESSION_MINUTES,
        },
      );
      if (!mutationDecision.eligible) {
        result.skipped.push({ id, reason: mutationDecision.reason });
        continue;
      }

      const mutationReadiness = await options.getReadiness(mutationSession);
      if (mutationReadiness.state !== "ready") {
        result.skipped.push({ id, reason: "not-stable" });
        continue;
      }

      result.eligible += 1;
      const stopped = await options.manager.stopSession(id);
      if (!stopped) {
        result.skipped.push({ id, reason: "missing" });
        continue;
      }
      options.onClosed(id);
      result.closed.push(id);
    } catch (error) {
      result.failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
