import type { SessionSnapshot } from "../agents/process-manager";
import { isAutomaticallyStartedSession } from "./autosession-cleanup";

export function shouldArchiveStoppedSession(
  session: SessionSnapshot,
  options: { isProtected?: (sessionId: string) => boolean } = {},
): boolean {
  if (session.status !== "stopped") {
    return false;
  }
  if (!isAutomaticallyStartedSession(session)) {
    return false;
  }
  if (options.isProtected?.(session.id)) {
    return false;
  }
  return true;
}
