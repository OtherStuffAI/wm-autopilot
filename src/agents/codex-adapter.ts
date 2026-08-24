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
  type ThreadItem,
  type AgentMessageItem,
  type Usage,
} from "@openai/codex-sdk";

import type {
  AgentAdapter,
  AdapterSessionContext,
  AdapterStreamEvent,
  PromptReadiness,
} from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CollectedMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

/**
 * Codex turn/stream errors arrive as a string that is often a JSON envelope
 * like `{"detail":"..."}`. Unwrap it to the human-readable message.
 */
export function extractCodexErrorMessage(raw: string | undefined | null): string {
  const fallback = "Codex turn failed";
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown; message?: unknown };
      const detail =
        typeof parsed.detail === "string"
          ? parsed.detail
          : typeof parsed.message === "string"
            ? parsed.message
            : null;
      if (detail) return detail;
    } catch {
      // Not JSON after all — fall through to the raw string.
    }
  }
  return trimmed || fallback;
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter implements AgentAdapter {
  private readonly codex: Codex;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private state: AdapterState = "initializing";
  private readonly messages: CollectedMessage[] = [];
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
    const env = context.env ?? {};
    const apiKey =
      env.CODEX_API_KEY ||
      env.OPENAI_API_KEY ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "";
    const baseUrl =
      env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || undefined;

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
      env: {
        ...process.env as Record<string, string>,
        ...env,
      },
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

    // Accumulate assistant text per agent_message item so streaming updates
    // grow a single assistant bubble (matched in the UI by role + createdAt).
    const agentTextById = new Map<string, string>();
    let assistantCreatedAt: string | null = null;
    let usage: Usage | null = null;
    let turnError: string | null = null;

    const emitAssistant = () => {
      if (!assistantCreatedAt) {
        assistantCreatedAt = new Date().toISOString();
      }
      const text = Array.from(agentTextById.values()).join("");
      // Expose the growing bubble to fetchMessages() so polled snapshots and
      // page refreshes mid-turn include the in-flight assistant text.
      this.pendingAssistant = { role: "assistant", content: text, createdAt: assistantCreatedAt };
      this.emitStream({
        type: "message",
        message: { role: "assistant", content: text, createdAt: assistantCreatedAt },
      });
    };

    try {
      const { events } = await this.thread.runStreamed(content, {
        signal: abortController.signal,
      });

      // Capture the thread ID after the first turn if not yet stored
      if (!this.threadId && this.thread.id) {
        this.threadId = this.thread.id;
        this.context.onNativeSessionId?.(this.threadId);
      }

      for await (const event of events) {
        // Broadcast raw events to any registered onEvent() listeners.
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch {
            // Non-fatal: listener errors don't interrupt the stream
          }
        }

        // Capture thread ID from thread.started event
        if (event.type === "thread.started") {
          this.threadId = event.thread_id;
          this.context.onNativeSessionId?.(this.threadId);
          continue;
        }

        // Stream assistant text as it is produced (started → updated → completed).
        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          const item = event.item as ThreadItem;
          if (item.type === "agent_message") {
            agentTextById.set(item.id, (item as AgentMessageItem).text);
            emitAssistant();
          }
          continue;
        }

        // Capture usage from turn completion
        if (event.type === "turn.completed") {
          usage = event.usage;
        }

        // Surface a clear turn/stream failure rather than the SDK's generic
        // "Codex Exec exited with code 1" wrapper.
        if (event.type === "turn.failed") {
          turnError = extractCodexErrorMessage(event.error?.message);
        } else if (event.type === "error") {
          turnError = extractCodexErrorMessage(event.message);
        }
      }

      if (turnError) {
        throw new Error(turnError);
      }

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
      const finalText = Array.from(agentTextById.values()).join("");
      if (finalText) {
        this.messages.push({
          role: "assistant",
          content: finalText,
          createdAt: assistantCreatedAt ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      if (
        abortController.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        const interrupted = new Error("Agent turn interrupted.");
        (interrupted as Error & { code?: string }).code = "agent_turn_interrupted";
        throw interrupted;
      }
      // Prefer the turn/stream error captured from the event stream over the
      // SDK's generic "Codex Exec exited with code 1" wrapper.
      if (turnError) {
        throw new Error(turnError);
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
    const history = [...this.messages];
    // Include the currently-streaming assistant turn so snapshot consumers
    // (refresh polling, page reload) never drop the in-flight bubble.
    if (this.pendingAssistant && this.pendingAssistant.content) {
      history.push(this.pendingAssistant);
    }
    return history.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
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
