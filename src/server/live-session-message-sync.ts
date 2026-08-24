import type { ProcessManager } from "../agents/process-manager";
import type { messageStore as MessageStoreInstance, StoredMessage } from "../storage/message-store";
import {
  syncLiveSessionMessages,
  type LiveSessionMessageSyncTiming,
} from "./live-session-messages";

interface LiveSessionMessageSyncOptions {
  manager: ProcessManager;
  messageStore: typeof MessageStoreInstance;
  agentHost: string;
  minimumRefreshIntervalMs?: number;
  requestTimeoutMs?: number;
  slowSyncThresholdMs?: number;
  logger?: Pick<Console, "info">;
}

export class LiveSessionMessageSync {
  private readonly inFlight = new Map<string, Promise<StoredMessage[]>>();
  private readonly lastCompletedAt = new Map<string, number>();

  constructor(private readonly options: LiveSessionMessageSyncOptions) {}

  sync(sessionId: string, force = false): Promise<StoredMessage[]> {
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;

    const minimumRefreshIntervalMs = this.options.minimumRefreshIntervalMs ?? 1000;
    const lastCompletedAt = this.lastCompletedAt.get(sessionId) ?? 0;
    if (force && Date.now() - lastCompletedAt < minimumRefreshIntervalMs) {
      return Promise.resolve(this.options.messageStore.listSessionMessages(sessionId));
    }

    const promise = syncLiveSessionMessages({
      sessionId,
      force,
      manager: this.options.manager,
      messageStore: this.options.messageStore,
      agentHost: this.options.agentHost,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 3000,
      onTiming: (timing) => this.logSlowSync(timing),
    }).finally(() => {
      this.lastCompletedAt.set(sessionId, Date.now());
      this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, promise);
    return promise;
  }

  private logSlowSync(timing: LiveSessionMessageSyncTiming): void {
    if (timing.totalMs < (this.options.slowSyncThresholdMs ?? 500)) return;
    this.options.logger?.info(
      `[live-message-sync] slow session=${timing.sessionId} total=${timing.totalMs}ms`
      + ` upstream=${timing.upstreamMs}ms authoritative=${timing.authoritativeMs}ms`
      + ` persistence=${timing.persistenceMs}ms`,
    );
  }
}
