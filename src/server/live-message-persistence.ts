import type { SessionSnapshot } from "../agents/process-manager";

type SessionEvent =
  | { type: "session-started"; session: SessionSnapshot }
  | { type: "session-updated"; session: SessionSnapshot }
  | { type: "session-stopped"; session: SessionSnapshot }
  | { type: "session-deleted"; session: SessionSnapshot };

interface SessionManagerLike {
  listSessions(): SessionSnapshot[];
  on(listener: (event: SessionEvent) => void): () => void;
}

interface LiveMessagePersistenceLoopOptions {
  manager: SessionManagerLike;
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
  intervalMs: number;
  initialDelayMs?: number;
  maxConcurrency?: number;
  onMessagesChanged?: (sessionId: string) => void;
  logger?: Pick<Console, "warn">;
}

const shouldPersistSession = (session: SessionSnapshot): boolean => session.status === "running";

export class LiveMessagePersistenceLoop {
  private readonly inFlight = new Set<string>();
  private readonly lastSyncAt = new Map<string, number>();
  private readonly messageRevisions = new Map<string, string>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private initialSweepHandle: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: LiveMessagePersistenceLoopOptions) {}

  start() {
    if (this.intervalHandle) {
      return;
    }

    this.unsubscribe = this.options.manager.on((event) => {
      if (event.type === "session-stopped" || event.type === "session-deleted") {
        this.lastSyncAt.delete(event.session.id);
        this.messageRevisions.delete(event.session.id);
        this.inFlight.delete(event.session.id);
        return;
      }
      if (event.type === "session-started") {
        this.lastSyncAt.set(event.session.id, 0);
      }
    });

    const initialDelay = Math.max(0, this.options.initialDelayMs ?? 0);
    if (initialDelay === 0) {
      void this.sweepOnce();
    } else {
      this.initialSweepHandle = setTimeout(() => {
        this.initialSweepHandle = null;
        void this.sweepOnce();
      }, initialDelay);
      this.initialSweepHandle.unref?.();
    }

    this.intervalHandle = setInterval(() => {
      void this.sweepOnce();
    }, this.options.intervalMs);
    this.intervalHandle.unref?.();
  }

  stop() {
    if (this.initialSweepHandle) {
      clearTimeout(this.initialSweepHandle);
      this.initialSweepHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.inFlight.clear();
    this.lastSyncAt.clear();
    this.messageRevisions.clear();
  }

  async sweepOnce() {
    const now = Date.now();
    const dueSessions = this.options.manager
      .listSessions()
      .filter((session) => shouldPersistSession(session))
      .filter((session) => {
        const last = this.lastSyncAt.get(session.id) ?? 0;
        return now - last >= this.options.intervalMs;
      });

    const queue = [...dueSessions];
    const workerCount = Math.min(
      queue.length,
      Math.max(1, this.options.maxConcurrency ?? 2),
    );
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const session = queue.shift();
        if (session) await this.syncSession(session.id);
      }
    }));
  }

  private async syncSession(sessionId: string) {
    if (this.inFlight.has(sessionId)) {
      return;
    }
    const session = this.options.manager.listSessions().find((entry) => entry.id === sessionId);
    if (!session || !shouldPersistSession(session)) {
      return;
    }

    this.inFlight.add(sessionId);
    this.lastSyncAt.set(sessionId, Date.now());
    try {
      const messages = await this.options.syncSessionMessages(sessionId, true);
      const revision = resolveMessageRevision(messages);
      if (revision !== this.messageRevisions.get(sessionId)) {
        this.messageRevisions.set(sessionId, revision);
        this.options.onMessagesChanged?.(sessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn?.(`[live-message-persistence] sync failed for ${sessionId}: ${message}`);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}

function resolveMessageRevision(messages: unknown[]): string {
  const last = messages.at(-1);
  if (!last || typeof last !== "object" || Array.isArray(last)) return `${messages.length}`;
  const value = last as Record<string, unknown>;
  const role = typeof value.role === "string" ? value.role : "";
  const content = typeof value.content === "string" ? value.content : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  return `${messages.length}\0${role}\0${createdAt}\0${content}`;
}

export { shouldPersistSession };
