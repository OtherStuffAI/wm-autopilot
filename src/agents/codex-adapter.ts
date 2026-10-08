import { recordCodexSdkActivity } from "./codex-sdk-activity";
import { NativeSdkActivity } from "./native-sdk-contract";
/**
 * CodexAdapter — communicates with Codex directly via @openai/codex-sdk.
 *
 * Bypasses agentapi by using the SDK's thread management to start, stream,
 * and resume Codex sessions natively.  The ProcessManager still handles
 * lifecycle (port allocation, MCP injection, billing env), but no agentapi
 * process is spawned — the SDK manages the Codex CLI process itself.
 */

import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type Thread,
  type ThreadEvent,
} from "@openai/codex-sdk";

import type {
  AgentAdapter,
  AdapterSessionContext,
  AdapterStreamEvent,
  PromptReadiness,
} from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import { buildCodexRuntimeEnv } from "./codex-runtime-env";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CollectedMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

export { extractCodexErrorMessage } from "./codex-turn-runner";
import { runCodexTurn } from "./codex-turn-runner";

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter implements AgentAdapter {
  private readonly codex: Codex;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private state: AdapterState = "initializing";
  private readonly messages: CollectedMessage[] = [];
  private readonly activity = new NativeSdkActivity((message) => this.emitStream({ type: "message", message }));
  /**
   * The assistant message for the turn currently streaming. It is not yet in
   * `messages` (that only happens once the turn completes), but it must be part
   * of fetchMessages() so polled/refreshed snapshots always reflect the latest
   * streaming state instead of dropping the in-flight bubble.
   */
  private pendingAssistant: CollectedMessage | null = null;
  private readonly workingDirectory: string;
  private currentAbort: AbortController | null = null;

  /** Listeners registered via onEvent() for raw ThreadEvent bridging */
  private eventListeners: Array<(event: ThreadEvent) => void> = [];

  /** Listeners registered via subscribeToEvents() for browser SSE bridging */
  private streamListeners = new Set<(event: AdapterStreamEvent) => void>();

  constructor(private readonly context: AdapterSessionContext) {
    this.workingDirectory = context.workingDirectory ?? process.cwd();

    // Build SDK options from session env
    const env = buildCodexRuntimeEnv(process.env, context.env);
    const apiKey = env.CODEX_API_KEY || env.OPENAI_API_KEY || "";
    const baseUrl = env.OPENAI_BASE_URL || undefined;

    // Use the same codex binary the agentapi path resolves on PATH (e.g. a
    // pinned ~/.bun/bin/codex), not the older binary bundled inside
    // @openai/codex-sdk — the bundled one can lag behind the models configured
    // in ~/.codex/config.toml and fail every turn with "requires a newer
    // version of Codex".
    const codexCli = env.CODEX_CLI || process.env.CODEX_CLI || "codex";
    const codexPathOverride = Bun.which(codexCli) ?? codexCli;

    const codexOptions: CodexOptions = {
      apiKey: apiKey || undefined,
      baseUrl,
      codexPathOverride,
      env,
    };
    // `--config` overrides (Wingman MCP server, billing auth, etc.) that the
    // agentapi path would pass as `-c` flags. Without these the native SDK
    // session would lose MCP tools and credits billing auth.
    if (context.codexConfig) {
      codexOptions.config = context.codexConfig as CodexOptions["config"];
    }

    this.codex = new Codex(codexOptions);

    this.initialise();
  }

  // -----------------------------------------------------------------------
  // AgentAdapter interface
  // -----------------------------------------------------------------------

  async fetchStatus(_timeoutMs?: number): Promise<AgentRuntimeStatus | null> {
    switch (this.state) {
      case "initializing":
        return "running";
      case "ready":
        return "stable";
      case "busy":
        return "running";
      case "disposed":
        return null;
      default:
        return null;
    }
  }

  async getPromptReadiness(_timeoutMs?: number): Promise<PromptReadiness> {
    const observedAt = Date.now();
    switch (this.state) {
      case "initializing":
        return { state: "starting", reason: "codex-initializing", retryAfterMs: 1000, observedAt };
      case "ready":
        return { state: "ready", reason: "codex-ready", retryAfterMs: 250, observedAt };
      case "busy":
        return { state: "busy", reason: "codex-active-turn", retryAfterMs: 1000, observedAt };
      case "disposed":
        return { state: "unreachable", reason: "codex-disposed", retryAfterMs: 5000, observedAt };
      default:
        return { state: "unreachable", reason: "codex-unknown-state", retryAfterMs: 5000, observedAt };
    }
  }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    await this.runMessage(content, false);
  }

  /** Resolves only after a successful native turn.completed event. */
  async sendCompletedMessage(content: string): Promise<string> {
    if (this.state !== "ready") throw new Error("Codex completed-turn adapter is not ready");
    return await this.runMessage(content, true);
  }

  private async runMessage(content: string, requireCompletion: boolean): Promise<string> {
    if (this.state === "disposed") {
      throw new Error("CodexAdapter has been disposed");
    }

    // Record the user message and surface it to the live view immediately.
    const userCreatedAt = new Date().toISOString();
    this.messages.push({ role: "user", content, createdAt: userCreatedAt });
    this.emitStream({
      type: "message",
      message: { role: "user", content, createdAt: userCreatedAt },
    });

    // Ensure thread is ready
    if (!this.thread) {
      await this.waitForReady();
    }
    if (!this.thread) {
      throw new Error("Codex thread not initialised");
    }

    this.setState("busy");
    const abortController = new AbortController();
    this.currentAbort = abortController;

    const turnId = crypto.randomUUID();
    let assistantCreatedAt: string | null = null;
    try {
      const { finalText, usage } = await runCodexTurn(this.thread, content, {
        signal: abortController.signal,
        requireCompletion,
        onThreadId: (id) => { this.threadId = id; this.context.onNativeSessionId?.(id); },
        onEvent: (event) => {
          recordCodexSdkActivity(event, this.activity, turnId);
          for (const listener of this.eventListeners) {
            try { listener(event); } catch { /* Subscriber failure cannot interrupt the turn. */ }
          }
        },
        onAssistant: (text) => {
          assistantCreatedAt ??= new Date().toISOString();
          const message = { role: "assistant" as const, content: text, createdAt: assistantCreatedAt };
          this.pendingAssistant = message;
          this.emitStream({ type: "message", message });
        },
      });

      // Report usage to billing ledger
      if (usage && this.context.recordUsage) {
        this.context.recordUsage({
          sessionId: this.context.id,
          endpoint: '/v1/responses',
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        }).catch(err =>
          console.error(`[codex-adapter] billing error: ${(err as Error).message}`),
        );
      }

      // Record the assistant response for fetchMessages() history. Use the same
      // createdAt as the streamed events so the UI dedupes to a single bubble.
      if (finalText) {
        this.messages.push({
          role: "assistant",
          content: finalText,
          createdAt: assistantCreatedAt ?? new Date().toISOString(),
        });
      }
      return finalText;
    } catch (error) {
      if (
        abortController.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        const interrupted = new Error("Agent turn interrupted.");
        (interrupted as Error & { code?: string }).code = "agent_turn_interrupted";
        throw interrupted;
      }
      throw error;
    } finally {
      // The turn is over: the final text was committed to `messages` on success,
      // or discarded on error/abort. Either way the in-flight bubble is no longer
      // pending and must not linger in fetchMessages().
      this.pendingAssistant = null;
      if (this.currentAbort === abortController) {
        this.currentAbort = null;
      }
      this.setState("ready");
    }
  }

  deliversPromptsDirectly(): boolean {
    return true;
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    const history = [...this.messages, ...this.activity.snapshot()];
    // Include the currently-streaming assistant turn so snapshot consumers
    // (refresh polling, page reload) never drop the in-flight bubble.
    if (this.pendingAssistant && this.pendingAssistant.content) {
      history.push(this.pendingAssistant);
    }
    return history.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => ({ ...m }));
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (!this.currentAbort) {
      return false;
    }
    this.currentAbort.abort();
    return true;
  }

  getEventsUrl(): URL | null {
    // The SDK handles streaming internally — no HTTP SSE endpoint to proxy.
    // session-events.ts bridges to the browser via subscribeToEvents() instead.
    return null;
  }

  subscribeToEvents(listener: (event: AdapterStreamEvent) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "ready" || this.state === "busy") return;
    if (this.state === "disposed") {
      throw new Error("CodexAdapter has been disposed");
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;
    const pollMs = options?.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;

    while (this.state === "initializing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (this.state === "initializing") {
      throw new Error(`CodexAdapter not ready after ${timeoutMs}ms`);
    }
  }

  async dispose(): Promise<void> {
    this.setState("disposed");

    // Abort any in-flight turn
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }

    this.eventListeners = [];
    this.streamListeners.clear();
    this.thread = null;
  }

  // -----------------------------------------------------------------------
  // Public accessors (for process-manager / session persistence)
  // -----------------------------------------------------------------------

  /** The Codex thread ID — persist this for session resume across restarts */
  getThreadId(): string | null {
    return this.threadId;
  }

  /** Register a listener for SDK thread events (for future SSE bridging) */
  onEvent(listener: (event: ThreadEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Dispatch an adapter stream event to browser SSE subscribers. */
  private emitStream(event: AdapterStreamEvent): void {
    for (const listener of this.streamListeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break the turn.
      }
    }
  }

  /** Transition adapter state, emitting a status event to subscribers. */
  private setState(next: AdapterState): void {
    if (this.state === next || this.state === "disposed") {
      return;
    }
    this.state = next;
    const status: AgentRuntimeStatus | null =
      next === "busy" ? "running" : next === "disposed" ? null : "stable";
    this.emitStream({ type: "status", status });
  }

  private initialise(): void {
    try {
      const threadOptions: ThreadOptions = {
        workingDirectory: this.workingDirectory,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      };
      if (this.context.model) {
        threadOptions.model = this.context.model;
      }

      // Resume existing thread if we have a stored ID, otherwise start fresh
      if (this.context.codexThreadId) {
        this.thread = this.codex.resumeThread(
          this.context.codexThreadId,
          threadOptions,
        );
        this.threadId = this.context.codexThreadId;
        this.context.onNativeSessionId?.(this.threadId);
      } else {
        this.thread = this.codex.startThread(threadOptions);
      }

      this.state = "ready";
    } catch (error) {
      console.error(
        `[codex-adapter] Failed to initialise thread for session ${this.context.id}:`,
        (error as Error).message,
      );
      // Stay in initializing state — waitForReady will timeout
    }
  }
}
