import type { ProcessManager } from "../agents/process-manager";

export const closeDispatchedWorker = async (
  sessionId: string,
  manager: ProcessManager,
  scheduleArchive: (sessionId: string) => void,
): Promise<void> => {
  const session = manager.getSession(sessionId);
  if (!session) return;

  if (session.status === "running" || session.status === "starting") {
    await manager.stopSession(sessionId);
  }

  scheduleArchive(sessionId);
};
