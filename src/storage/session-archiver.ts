import { sessionArchiveStore } from "./session-archive-store";
import { messageStore } from "./message-store";
import type { ProcessManager } from "../agents/process-manager";
import type { SessionSnapshot } from "../agents/process-manager";
import { normaliseSessionMetadata } from "../sessions/session-metadata";

const ARCHIVE_DELAY_MS = 5000;

// Track pending archive timers so we can cancel if session restarts
const pendingArchives = new Map<string, ReturnType<typeof setTimeout>>();

export const cancelPendingArchive = (sessionId: string): void => {
  const timer = pendingArchives.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingArchives.delete(sessionId);
  }
};

export const scheduleSessionArchive = (
  sessionId: string,
  manager: ProcessManager
): void => {
  // Cancel any existing pending archive for this session
  cancelPendingArchive(sessionId);

  const timer = setTimeout(() => {
    pendingArchives.delete(sessionId);
    archiveSession(sessionId, manager);
  }, ARCHIVE_DELAY_MS);

  pendingArchives.set(sessionId, timer);
};

const archiveSession = (sessionId: string, manager: ProcessManager): void => {
  try {
    // Get session from process manager
    const session = manager.getSession(sessionId);

    // Get stored session record for metadata
    const storedSessions = messageStore.listSessions();
    const storedSession = storedSessions.find((s) => s.id === sessionId);

    // Check if session is still stopped (not restarted)
    if (session && (session.status === "running" || session.status === "starting")) {
      console.log(`[archive] Session ${sessionId} was restarted, skipping archive`);
      return;
    }

    const archiveMetadata = resolveArchiveMetadata(storedSession, session, sessionId);
    if (!archiveMetadata) {
      console.warn(`[archive] Session ${sessionId} metadata not found, skipping archive`);
      return;
    }

    // Get messages for this session
    const messages = messageStore.listSessionMessages(sessionId);

    // Archive the session
    sessionArchiveStore.archiveSession({
      id: archiveMetadata.id,
      agent: archiveMetadata.agent,
      name: archiveMetadata.name,
      npub: archiveMetadata.npub,
      workingDirectory: archiveMetadata.workingDirectory,
      startedAt: archiveMetadata.startedAt,
      origin: archiveMetadata.origin,
      metadata: archiveMetadata.metadata,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });

    // Clean up from active stores
    manager.deleteSession(sessionId);
    messageStore.removeSession(sessionId);
  } catch (error) {
    console.error(`[archive] Failed to archive session ${sessionId}:`, error);
  }
};

const resolveArchiveMetadata = (
  storedSession: ReturnType<typeof messageStore.listSessions>[number] | undefined,
  liveSession: SessionSnapshot | undefined,
  sessionId: string,
) => {
  if (storedSession) {
    return {
      id: storedSession.id,
      agent: storedSession.agent,
      name: storedSession.name,
      npub: storedSession.npub,
      workingDirectory: storedSession.workingDirectory,
      startedAt: storedSession.startedAt,
      origin: storedSession.origin,
      metadata: normaliseSessionMetadata(storedSession.metadata),
    };
  }

  if (!liveSession) {
    return null;
  }

  console.warn(`[archive] Session ${sessionId} missing store record, using live session metadata`);
  return {
    id: liveSession.id,
    agent: liveSession.agent,
    name: liveSession.name ?? null,
    npub: liveSession.npub ?? null,
    workingDirectory: liveSession.workingDirectory ?? null,
    startedAt: liveSession.startedAt,
    origin: liveSession.origin ?? null,
    metadata: normaliseSessionMetadata(liveSession.metadata),
  };
};

export const getArchivePendingCount = (): number => {
  return pendingArchives.size;
};
