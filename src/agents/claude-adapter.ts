import { ClaudeSdkPermissions } from "./claude-sdk-permissions";
import { randomUUID } from "node:crypto";
import { startup, type Query, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AdapterSessionContext, AdapterStreamEvent, PromptReadiness } from "./agent-adapter";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import type { AgentRuntimeStatus } from "../types/agent-status";
import { ClaudeEventNormalizer } from "./claude-event-normalizer";
import { buildClaudeSdkOptions, sanitizeClaudeSdkError } from "./claude-sdk-options";
import { NativeSdkActivity } from "./native-sdk-contract";

type State = "initializing" | "ready" | "busy" | "failed" | "disposed";

/** Autopilot owns lifecycle; the official SDK owns only its Claude subprocess. */
export class ClaudeAdapter implements AgentAdapter {
  private state: State = "initializing";
  private warm: WarmQuery | null = null;
  private query: Query | null = null;
  private startPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private failure: Error | null = null;
  private sessionId: string | null;
  private resume: boolean;
  private runningModel: string | null = null;
  private readonly listeners = new Set<(event: AdapterStreamEvent) => void>();
  private readonly permissions: ClaudeSdkPermissions;
  private readonly activity = new NativeSdkActivity((message) => this.emit({ type: "message", message }));

  constructor(private readonly context: AdapterSessionContext, private readonly start: typeof startup = startup) {
    this.permissions = new ClaudeSdkPermissions(context.id, (permission) => this.emit({ type: "permission", permission }),
      (text) => sanitizeClaudeSdkError(new Error(text), context.env).message);
    this.activity.hydrate((context.nativeSdkHistory ?? []).map((message) => ({
      ...message, content: sanitizeClaudeSdkError(new Error(message.content), context.env).message,
    })));
    this.sessionId = context.claudeSessionId ?? null;
    this.resume = context.claudeResume ?? false;
    void this.waitForReady().catch(() => { /* Readiness exposes the stored startup failure. */ });
  }

  async fetchStatus(): Promise<AgentRuntimeStatus | null> {
    if (this.state === "disposed" || this.state === "failed") return null;
    return this.state === "ready" ? "stable" : "running";
  }

  async getPromptReadiness(): Promise<PromptReadiness> {
    const state = this.state === "ready" ? "ready" : this.state === "busy" ? "busy"
      : this.state === "initializing" ? "starting" : "unreachable";
    return { state, reason: `claude-sdk-${this.state}`, retryAfterMs: 250, observedAt: Date.now() };
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "disposed") throw new Error("ClaudeAdapter has been disposed");
    if (this.failure) throw this.failure;
    if (this.state === "busy" || this.warm) return;
    this.startPromise ??= this.initialize(options?.timeoutMs ?? 30_000).finally(() => { this.startPromise = null; });
    await this.startPromise;
  }

  private async initialize(timeoutMs: number): Promise<void> {
    this.setState("initializing");
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const options = await buildClaudeSdkOptions({
        ...this.context, claudeSessionId: this.sessionId ?? undefined, claudeResume: this.resume,
      }, controller);
      options.canUseTool = this.permissions.canUseTool;
      const warm = await this.start({ options, initializeTimeoutMs: timeoutMs });
      if (this.state === "disposed" || controller.signal.aborted) {
        warm.close();
        throw new Error("Claude SDK initialization cancelled");
      }
      this.warm = warm;
      this.setState("ready");
    } catch (error) {
      this.failure = sanitizeClaudeSdkError(error, this.context.env);
      this.setState("failed");
      throw this.failure;
    }
  }

  async sendMessage(content: string): Promise<void> {
    if (this.state === "busy") throw new Error("Claude SDK already has an active turn");
    await this.waitForReady();
    // Another caller may have claimed the warm process while readiness awaited.
    if (!this.warm) throw new Error("Claude SDK is not ready for a new turn");
    const warm = this.warm;
    this.warm = null;
    const controller = this.abortController!;
    const turnId = randomUUID();
    const redact = (text: string) => sanitizeClaudeSdkError(new Error(text), this.context.env).message;
    const normalizer = new ClaudeEventNormalizer(this.activity, turnId, redact);
    this.setState("busy");
    this.activity.upsert(`${turnId}:user`, "user", redact(content));
    try {
      this.query = warm.query(content);
      let completed = false;
      for await (const message of this.query) {
        if (controller.signal.aborted) throw new Error("Agent turn interrupted.");
        if (message.type === "system" && message.subtype === "init") {
          this.captureSession(message.session_id);
          this.runningModel = message.model;
          const wingman = message.mcp_servers.find((server) => server.name === "wingman");
          if (wingman?.status !== "connected") throw new Error("Claude SDK Wingman MCP server is not connected");
        }
        if (message.type === "result") {
          if (message.origin?.kind === "task-notification") continue;
          this.captureSession(message.session_id);
          normalizer.complete(message);
          completed = true;
          break;
        }
        normalizer.accept(message);
      }
      if (!completed) throw new Error("Native completed assistant output missing");
    } catch (error) {
      const failure = controller.signal.aborted
        ? Object.assign(new Error("Agent turn interrupted."), { code: "agent_turn_interrupted" })
        : sanitizeClaudeSdkError(error, this.context.env);
      normalizer.abort();
      this.activity.upsert(`${turnId}:error`, "agent-error", failure.message);
      throw failure;
    } finally {
      this.query?.close();
      this.query = null;
      warm.close();
      this.abortController = null;
      this.setState("ready");
    }
  }

  deliversPromptsDirectly(): boolean { return true; }
  getEventsUrl(): null { return null; }
  getSessionId(): string | null { return this.resume ? this.sessionId : null; }
  getPendingPermissions() { return this.permissions.list(); }
  async respondToPermission(id: string, response: "once" | "always" | "reject"): Promise<boolean> {
    return this.permissions.respond(id, response);
  }
  getRunningModel(): string | null { return this.runningModel; }
  async fetchMessages(): Promise<AgentMessage[]> { return this.activity.snapshot(); }

  subscribeToEvents(listener: (event: AdapterStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (this.state !== "busy" || !this.abortController) return false;
    this.permissions.cancel();
    this.abortController.abort();
    this.query?.close();
    return true;
  }

  async dispose(): Promise<void> {
    this.setState("disposed");
    this.permissions.cancel();
    this.abortController?.abort();
    this.query?.close();
    this.warm?.close();
    this.warm = null;
    this.listeners.clear();
  }

  private captureSession(id: string): void {
    if (!id) throw new Error("Claude SDK native session identity is missing");
    this.sessionId = id;
    this.resume = true;
    this.context.onNativeSessionId?.(id);
  }

  private setState(next: State): void {
    if (this.state === "disposed" || this.state === next) return;
    this.state = next;
    this.emit({ type: "status", status: next === "ready" ? "stable"
      : next === "disposed" || next === "failed" ? null : "running" });
  }

  private emit(event: AdapterStreamEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Subscriber failures cannot change SDK lifecycle. */ }
    }
  }
}
