import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import type { SessionMetadata } from "./session-metadata";

type SessionMetadataManager = Pick<ProcessManager, "updateSessionMetadata">;

export function markSessionExplicitlyClosed(
  manager: SessionMetadataManager,
  sessionId: string,
  now: Date = new Date(),
): SessionSnapshot {
  const session = manager.updateSessionMetadata(sessionId, {
    explicitlyClosedAt: now.toISOString(),
  });
  if (!session) {
    throw new Error(`Cannot persist explicit close state for missing session ${sessionId}`);
  }
  return session;
}

export function isSessionExplicitlyClosed(
  metadata: SessionMetadata | null | undefined,
): boolean {
  return typeof metadata?.explicitlyClosedAt === "string";
}
