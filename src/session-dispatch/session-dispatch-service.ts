import { createHash } from "node:crypto";
import type { AgentType } from "../agent-types";
import { resolveAuthoritativeSessionMessages } from "../agents/authoritative-session-messages";
import type { SessionOrigin, SessionSnapshot } from "../agents/process-manager";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";
import type { PromptQueueStore } from "../storage/prompt-queue-store";
import type { SessionDispatchInboxCoordinator, DispatchCallbackInbox } from "./session-dispatch-inbox";
import { SessionDispatchStore, type DispatchState, type SessionDispatch, type TerminalStatus } from "./session-dispatch-store";

export interface CreateDispatchInput {
  agent: AgentType;
  directory?: string;
  name?: string;
  prompt: string;
  callbackSessionId: string | null;
  callbackEnabled: boolean;
  reportingContext?: Record<string, unknown>;
}

export interface DispatchManager {
  getSession(id: string): SessionSnapshot | undefined | null;
  getAdapter(id: string): ReturnType<import("../agents/process-manager").ProcessManager["getAdapter"]>;
  createSession(agent: AgentType, directory?: string, name?: string, origin?: SessionOrigin | null,
    targetFile?: string, explicitNpub?: string, metadata?: Record<string, unknown>): Promise<SessionSnapshot>;
  captureAgentapiCodexSessionIdFromPrompt?(id: string, prompt: string,
    options?: { sentAtMs?: number; attempts?: number; retryMs?: number }): Promise<boolean>;
}

export interface SessionDispatchCloseoutPolicy {
  now?: () => Date;
  nativeDiscoveryRetryInitialMs?: number;
  nativeDiscoveryRetryMaxMs?: number;
  nativeDiscoveryTimeoutMs?: number;
}

const DEFAULT_CLOSEOUT_POLICY = {
  nativeDiscoveryRetryInitialMs: 1_000,
  nativeDiscoveryRetryMaxMs: 30_000,
  nativeDiscoveryTimeoutMs: 30 * 60_000,
};

export class SessionDispatchService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(
    private store: SessionDispatchStore,
    private manager: DispatchManager,
    private promptQueue: PromptQueueStore,
    private dispatchQueuedPrompt: (session: SessionSnapshot) => void | Promise<void>,
    private closeoutPolicy: SessionDispatchCloseoutPolicy = {},
    private closeWorker: (sessionId: string) => void | Promise<void> = () => {},
    private inbox?: SessionDispatchInboxCoordinator,
    private requestNextTurn: (sessionId: string) => void | Promise<void> = () => {},
  ) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkRunning(), intervalMs);
    this.timer.unref?.();
    void this.checkRunning();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async create(input: CreateDispatchInput): Promise<SessionDispatch> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    if (input.callbackEnabled && !input.callbackSessionId) {
      throw new Error("callbackSessionId is required when callbacks are enabled");
    }
    const callback = input.callbackSessionId ? this.requireSession(input.callbackSessionId) : null;
    const ownerNpub = callback ? resolveSessionOwnerNpub(callback.npub, callback.metadata) : null;
    const reportingContext = input.reportingContext ?? (callback ? this.inheritReportingContext(callback) : {});
    const worker = await this.manager.createSession(
      input.agent, input.directory, input.name, { type: "session-dispatch", id: input.callbackSessionId ?? "unmonitored" },
      undefined, ownerNpub ?? undefined,
      { role: "dispatched-worker", callbackSessionId: input.callbackSessionId ?? undefined },
    );
    const workerOwner = resolveSessionOwnerNpub(worker.npub, worker.metadata);
    if (callback && workerOwner !== ownerNpub) {
      throw new Error("Worker and callback session must have the same owner");
    }
    const queuedAt = new Date().toISOString();
    let record: SessionDispatch;
    try {
      record = this.store.create({
        workerSessionId: worker.id, callbackSessionId: input.callbackEnabled ? input.callbackSessionId : null,
        ownerNpub, state: "running", prompt, promptQueuedAt: queuedAt,
        reportingContext, terminalStatus: null, terminalMessage: null,
        terminalMessageCreatedAt: null, terminalFingerprint: null, callbackPrompt: null,
        nativeDiscoveryStartedAt: null, nativeDiscoveryNextAttemptAt: null,
        nativeDiscoveryAttemptCount: 0, nativeDiscoveryLastError: null,
        callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null,
        callbackQueuedAt: null, callbackAcknowledgedAt: null,
        closedAt: null, lastError: null,
      });
    } catch (error) {
      throw new Error(`Worker ${worker.id} was created but its dispatch record could not be persisted: ${(error as Error).message}`);
    }
    try {
      const queued = this.promptQueue.addPrompt(worker.id, { content: prompt, type: "session_dispatch", payload: { dispatchId: record.dispatchId } });
      if (!queued) throw new Error("worker prompt was empty or duplicated");
      await this.dispatchQueuedPrompt(worker);
    } catch (error) {
      this.store.update(record.dispatchId, { state: "failed", lastError: (error as Error).message });
      throw new Error(`Dispatch ${record.dispatchId} created worker ${worker.id}, but its prompt could not be queued: ${(error as Error).message}`);
    }
    return record;
  }

  get(id: string, callerSessionId?: string | null): SessionDispatch {
    const record = this.store.get(id);
    if (!record) throw new Error("Dispatch not found");
    this.assertOwner(record, callerSessionId);
    return record;
  }

  list(callerSessionId?: string | null, filters: { state?: DispatchState } = {}): SessionDispatch[] {
    const caller = callerSessionId ? this.requireSession(callerSessionId) : null;
    return this.store.list({ ...filters, ownerNpub: caller ? resolveSessionOwnerNpub(caller.npub, caller.metadata) : undefined });
  }

  getInbox(callerSessionId: string): DispatchCallbackInbox {
    this.requireSession(callerSessionId);
    if (!this.inbox) throw new Error("Dispatch callback inbox is unavailable");
    return this.inbox.inspect(callerSessionId);
  }

  acknowledge(id: string, callerSessionId: string): SessionDispatch {
    const record = this.get(id, callerSessionId);
    if (record.callbackSessionId !== callerSessionId) throw new Error("Only the callback session can acknowledge this dispatch");
    if (record.state !== "callback_pending" && record.state !== "callback_delivered" && record.state !== "acknowledged") {
      throw new Error(`Cannot acknowledge dispatch in ${record.state}`);
    }
    return this.store.update(id, { state: "acknowledged", callbackAcknowledgedAt: this.now().toISOString(),
      callbackExpiresAt: null });
  }

  close(id: string, callerSessionId: string): SessionDispatch {
    const record = this.get(id, callerSessionId);
    if (record.callbackSessionId !== callerSessionId) throw new Error("Only the callback session can close this dispatch");
    if (record.state !== "acknowledged" && record.state !== "closed") throw new Error("A dispatch must be acknowledged before it is closed");
    return this.store.update(id, { state: "closed", closedAt: this.now().toISOString() });
  }

  async retryCallback(id: string, callerSessionId: string): Promise<SessionDispatch> {
    const record = this.get(id, callerSessionId);
    if (record.callbackSessionId !== callerSessionId) throw new Error("Only the callback session can retry this dispatch");
    if (!record.terminalFingerprint) throw new Error("Dispatch has no terminal callback to retry");
    const pending = this.store.update(id, { state: "callback_pending", lastError: null,
      callbackAttemptCount: 0, callbackNextAttemptAt: null, callbackExpiresAt: null,
      callbackQueuedAt: null, callbackAcknowledgedAt: null, closedAt: null });
    await this.requestNextTurn(callerSessionId);
    return pending;
  }

  migrateLegacyCallbacks(): { removedPromptRows: number; recoveredDispatches: number } {
    if (!this.inbox) throw new Error("Dispatch callback inbox is unavailable");
    return this.inbox.migrateLegacyCallbacks(this.promptQueue);
  }

  async checkRunning(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const record of this.store.list()) {
        if (record.state === "running") await this.captureIfTerminal(record);
      }
    } finally {
      this.checking = false;
    }
  }

  private async captureIfTerminal(record: SessionDispatch): Promise<void> {
    let session = this.manager.getSession(record.workerSessionId);
    if (!session) return;
    const adapter = this.manager.getAdapter(record.workerSessionId);
    if (!adapter) {
      if (session.status === "error") await this.capture(record, "failed", null, null);
      else if (session.status === "stopped") await this.capture(record, "stopped", null, null);
      return;
    }
    const agentapiCodex = session.agent === "codex" && !adapter.deliversPromptsDirectly?.();
    if (agentapiCodex && !session.metadata?.nativeAgentSession?.sessionId) {
      const discovered = await this.discoverNativeCodexSession(record);
      if (!discovered) return;
      session = this.manager.getSession(record.workerSessionId);
      if (!session?.metadata?.nativeAgentSession?.sessionId) return;
    }
    let status: string | null;
    let messages: Array<{ role: string; content: string; createdAt: string }>;
    try { [status, messages] = await Promise.all([adapter.fetchStatus(), adapter.fetchMessages()]); } catch { return; }
    const nativeCodex = session.agent === "codex" && Boolean(session.metadata?.nativeAgentSession?.sessionId);
    const authoritative = nativeCodex
      ? await resolveAuthoritativeSessionMessages(session, messages, { requireNative: true }).catch(() => [])
      : adapter.deliversPromptsDirectly?.() ? messages : [];
    const boundary = authoritative.findLastIndex((message) => message.role === "user" && message.content === record.prompt);
    const final = (boundary >= 0 ? authoritative.slice(boundary + 1) : [])
      .filter((message) => (message.role === "assistant" || message.role === "agent") && message.content.trim()).at(-1);
    if (final && (nativeCodex || status === "stable")) await this.capture(record, "completed", final.content, final.createdAt);
    else if (session.status === "error") await this.capture(record, "failed", null, null);
    else if (session.status === "stopped") await this.capture(record, "stopped", null, null);
  }

  private async discoverNativeCodexSession(record: SessionDispatch): Promise<boolean> {
    const now = this.now();
    const startedAt = record.nativeDiscoveryStartedAt
      ? new Date(record.nativeDiscoveryStartedAt)
      : now;
    if (now.getTime() - startedAt.getTime() >= this.policyValue("nativeDiscoveryTimeoutMs")) {
      await this.capture(record, "failed",
        "Codex completed without a discoverable native transcript; the completion callback could not be verified.",
        now.toISOString());
      return false;
    }
    const nextAttemptAt = record.nativeDiscoveryNextAttemptAt
      ? new Date(record.nativeDiscoveryNextAttemptAt)
      : null;
    if (nextAttemptAt && now < nextAttemptAt) return false;

    const attemptCount = record.nativeDiscoveryAttemptCount + 1;
    const capture = this.manager.captureAgentapiCodexSessionIdFromPrompt;
    if (!capture) {
      await this.capture(record, "failed",
        "Codex native-session discovery is unavailable; the completion callback could not be verified.",
        now.toISOString());
      return false;
    }

    let discovered = false;
    let discoveryError: string | null = null;
    try {
      discovered = await capture.call(this.manager, record.workerSessionId, record.prompt, {
        sentAtMs: Date.parse(record.promptQueuedAt),
        attempts: 1,
        retryMs: 0,
      });
    } catch (error) {
      discoveryError = (error as Error).message;
    }

    this.store.update(record.dispatchId, {
      nativeDiscoveryStartedAt: startedAt.toISOString(),
      nativeDiscoveryAttemptCount: attemptCount,
      nativeDiscoveryNextAttemptAt: discovered
        ? null
        : this.addMs(now, this.nativeDiscoveryRetryDelayMs(attemptCount)).toISOString(),
      nativeDiscoveryLastError: discovered
        ? null
        : discoveryError ?? "Codex native transcript is not available yet",
    });
    return discovered;
  }

  private async capture(record: SessionDispatch, status: TerminalStatus, message: string | null, createdAt: string | null): Promise<void> {
    const fingerprint = createHash("sha256").update(`${status}\0${createdAt ?? ""}\0${message ?? ""}`).digest("hex");
    if (record.terminalFingerprint === fingerprint) return;
    if (!record.callbackSessionId) {
      this.store.update(record.dispatchId, { state: "closed", terminalStatus: status, terminalMessage: message,
        terminalMessageCreatedAt: createdAt, terminalFingerprint: fingerprint, closedAt: this.now().toISOString() });
      await this.closeTerminalWorker(record);
      return;
    }
    this.store.update(record.dispatchId, { state: "callback_pending", terminalStatus: status,
      terminalMessage: message, terminalMessageCreatedAt: createdAt, terminalFingerprint: fingerprint,
      callbackPrompt: null, callbackNextAttemptAt: null, callbackExpiresAt: null, lastError: null });
    await this.closeTerminalWorker(record);
    await this.requestNextTurn(record.callbackSessionId);
  }

  private async closeTerminalWorker(record: SessionDispatch): Promise<void> {
    try {
      await this.closeWorker(record.workerSessionId);
    } catch (error) {
      this.store.update(record.dispatchId, {
        lastError: `Worker closeout failed: ${(error as Error).message}`,
      });
    }
  }

  private nativeDiscoveryRetryDelayMs(attempts: number): number {
    const initial = this.policyValue("nativeDiscoveryRetryInitialMs");
    return Math.min(initial * (2 ** Math.max(0, attempts - 1)),
      this.policyValue("nativeDiscoveryRetryMaxMs"));
  }

  private policyValue(key: keyof typeof DEFAULT_CLOSEOUT_POLICY): number {
    return this.closeoutPolicy[key] ?? DEFAULT_CLOSEOUT_POLICY[key];
  }

  private now(): Date {
    return this.closeoutPolicy.now?.() ?? new Date();
  }

  private addMs(date: Date, milliseconds: number): Date {
    return new Date(date.getTime() + milliseconds);
  }

  private requireSession(id: string): SessionSnapshot {
    const session = this.manager.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private inheritReportingContext(session: SessionSnapshot): Record<string, unknown> {
    const metadata = session.metadata;
    const context: Record<string, unknown> = {};
    if (metadata?.flightdeckWorkspaceId) context.workspaceId = metadata.flightdeckWorkspaceId;
    if (metadata?.flightdeckChannelId) context.channelId = metadata.flightdeckChannelId;
    if (metadata?.flightdeckThreadId) context.threadId = metadata.flightdeckThreadId;
    if (metadata?.bindingType === "task" && metadata.bindingId) context.taskId = metadata.bindingId;
    else if (metadata?.taskIds?.length === 1) context.taskId = metadata.taskIds[0];
    return context;
  }

  private assertOwner(record: SessionDispatch, callerSessionId?: string | null): void {
    if (!callerSessionId) return;
    const caller = this.requireSession(callerSessionId);
    const callerOwner = resolveSessionOwnerNpub(caller.npub, caller.metadata);
    if (callerOwner !== record.ownerNpub) throw new Error("Dispatch belongs to another owner");
  }
}
