import type { SessionSnapshot } from "../agents/process-manager";
import { shouldArchiveStoppedSession } from "./stopped-session-archive";

/** Retry archives deferred while an Agent Direct turn still owned the session. */
export function recoverStoppedAutoSessionArchives(
  sessions: SessionSnapshot[],
  isProtected: (sessionId: string) => boolean,
  scheduleArchive: (sessionId: string) => void,
): string[] {
  const scheduled: string[] = [];
  for (const session of sessions) {
    if (!shouldArchiveStoppedSession(session, { isProtected })) continue;
    scheduleArchive(session.id);
    scheduled.push(session.id);
  }
  return scheduled;
}
