import type { ProcessManager } from "../agents/process-manager";
import type { AgentType } from "../config";
import { isAutomaticallyStartedSession } from "./autosession-cleanup";

type NextActionCleanupDetail = {
  id: string;
  agent: AgentType;
  name: string;
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
};

export interface NextActionCleanupDeps {
  manager: ProcessManager;
  scheduleArchive: (sessionId: string) => void;
  isSessionProtected?: (sessionId: string) => boolean;
}

export async function cleanupStopNextActionSessions(
  deps: NextActionCleanupDeps,
): Promise<NextActionCleanupResult> {
  const sessions = deps.manager.listSessions();
  const candidates = sessions.filter((session) => session.metadata?.nextAction === "stop"
    && isAutomaticallyStartedSession(session)
    && !deps.isSessionProtected?.(session.id));
  const details: NextActionCleanupDetail[] = [];
  let stopped = 0;
  let archiveScheduled = 0;
  let failed = 0;

  for (const session of candidates) {
    const detail: NextActionCleanupDetail = {
      id: session.id,
      agent: session.agent,
      name: session.name,
      stopped: false,
      archiveScheduled: false,
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
    timestamp: new Date().toISOString(),
    checked: sessions.length,
    matched: candidates.length,
    stopped,
    archiveScheduled,
    failed,
    details,
  };
}
