import type { AgentRuntimeStatus } from "../types/agent-status";
import { writeServerLog } from "../logging/server-logger";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import type {
  AgentAdapter,
  AdapterSessionContext,
  AdapterStreamEvent,
  AgentPermission,
  AgentPermissionOption,
  PromptReadiness,
} from "./agent-adapter";
import { AcpEventNormalizer } from "./acp-event-normalizer";
import { AcpProcessClient, type AcpEvent, type AcpRequest, type AcpResponse } from "./acp-process-client";

type AdapterState = "initializing" | "ready" | "busy" | "failed" | "disposed";
type PermissionResponse = "once" | "always" | "reject";

export class AcpPermissionResponseError extends Error {
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "AcpPermissionResponseError";
  }
}

export const ACP_PROTOCOL_VERSION = "2025-01-01";

export interface AcpAdapterProfile {
  agentName: string;
  command: string;
  args?: string[];
  env: Record<string, string>;
  protocolVersion?: string | number;
  sessionId?: string | null;
  mcpServers?: Array<Record<string, unknown>>;
  cancelIsNotification?: boolean;
  aggregateAutoApprovedPermissions?: boolean;
  rollIntermediateAgentMessages?: boolean;
  configureSession?: (client: AcpProcessClient, sessionId: string, response: AcpResponse) => Promise<void>;
  formatStartupError?: (error: Error) => Error;
}

export class AcpAdapter implements AgentAdapter {
  private state: AdapterState = "initializing";
  private client: AcpProcessClient | null = null;
  private startPromise: Promise<void> | null = null;
  private sessionId: string | null;
  private messages: AgentMessage[] = [];
  private failure: Error | null = null;
  private readonly eventListeners = new Set<(event: AdapterStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, AcpRequest>();
  private readonly autoApprovedPermissionIds = new Set<string>();
  private readonly eventNormalizer: AcpEventNormalizer;
  private activePromptContent: string | null = null;

  constructor(
    private readonly context: AdapterSessionContext,
    private readonly profile: AcpAdapterProfile,
  ) {
    this.sessionId = profile.sessionId ?? null;
    this.eventNormalizer = new AcpEventNormalizer(undefined, {
      rollIntermediateAgentMessages: profile.rollIntermediateAgentMessages,
    });
  }

  async fetchStatus(): Promise<AgentRuntimeStatus | null> {
    if (this.state === "disposed" || this.state === "failed") return null;
    return this.state === "busy" || this.state === "initializing" || this.pendingPermissions.size > 0 ? "running" : "stable";
  }

  async getPromptReadiness(_timeoutMs?: number): Promise<PromptReadiness> {
    const observedAt = Date.now();
    const name = this.profile.agentName.toLowerCase();
    if (this.state === "disposed") return { state: "unreachable", reason: `${name}-disposed`, retryAfterMs: 5000, observedAt };
    if (this.state === "failed") return { state: "unreachable", reason: `${name}-acp-failed`, retryAfterMs: 5000, observedAt };
    if (this.state === "initializing") return { state: "starting", reason: `${name}-initializing`, retryAfterMs: 1000, observedAt };
    if (this.pendingPermissions.size > 0) {
      return { state: "busy", reason: `${name}-waiting-permission`, retryAfterMs: 1000, observedAt };
    }
    if (this.state === "busy") {
      return { state: "busy", reason: `${name}-active-turn`, retryAfterMs: 1000, observedAt };
    }
    return { state: "ready", reason: `${name}-ready`, retryAfterMs: 250, observedAt };
  }

  deliversPromptsDirectly(): boolean { return true; }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    await this.waitForReady();
    const sessionId = this.requireSessionId();
    const turnNumber = this.eventNormalizer.beginTurn({ expectUserEcho: true });
    const turnId = `acp-turn-${turnNumber}`;
    const userMessage: AgentMessage = {
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      messageId: `acp-turn-${turnNumber}-user`,
      turnId,
      order: (turnNumber - 1) * 1000,
    };
    this.activePromptContent = content;
    this.upsertMessage(userMessage);
    this.emit({ type: "message", message: userMessage });
    this.setState("busy");
    try {
      const response = await this.requireClient().request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: content }],
      }, { timeoutMs: null });
      this.assertSuccess(response, "session/prompt");
    } catch (error) {
      this.fail(error);
      throw this.failure;
    } finally {
      this.activePromptContent = null;
      if (this.state !== "failed") this.setState(this.pendingPermissions.size > 0 ? "busy" : "ready");
    }
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    if (this.state === "initializing" && !this.client && this.messages.length === 0) {
      await this.waitForReady();
    }
    return this.messages.slice();
  }

  getPendingPermissions(): AgentPermission[] {
    return [...this.pendingPermissions.entries()].map(([id, request]) => this.toPermission(id, request));
  }

  async respondToPermission(permissionId: string, response: PermissionResponse): Promise<boolean> {
    const request = this.pendingPermissions.get(permissionId);
    if (!request || !this.client) return false;
    const options = readPermissionOptions(request);
    const selected = options.find((option) => option.response === response);
    if (!selected) {
      const available = options.map((option) => option.label).join(", ") || "none";
      throw new AcpPermissionResponseError(
        `${this.profile.agentName} ACP permission does not offer ${permissionResponseLabel(response)}; available options: ${available}`,
      );
    }
    this.client.respond(request.id, { outcome: { outcome: "selected", optionId: selected.optionId } });
    this.pendingPermissions.delete(permissionId);
    return true;
  }

  async interruptCurrentTurn(): Promise<boolean> {
    if (this.state !== "busy" || !this.client || !this.sessionId) return false;
    this.cancelPendingPermissions();
    if (this.profile.cancelIsNotification) {
      this.client.notify("session/cancel", { sessionId: this.sessionId });
      return true;
    }
    const response = await this.client.request("session/cancel", { sessionId: this.sessionId });
    this.assertSuccess(response, "session/cancel");
    return true;
  }

  getEventsUrl(): URL | null { return null; }

  subscribeToEvents(listener: (event: AdapterStreamEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "disposed") throw new Error(`${this.profile.agentName} ACP adapter has been disposed`);
    if (this.failure) throw this.failure;
    await this.ensureStarted();
    const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
    while ((this.state === "busy" || this.pendingPermissions.size > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options?.pollIntervalMs ?? 100));
    }
    if (this.failure) throw this.failure;
    if (this.state === "busy" || this.pendingPermissions.size > 0) {
      throw new Error(`${this.profile.agentName} ACP adapter is still processing a prompt`);
    }
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
    this.pendingPermissions.clear();
    const client = this.client;
    this.client = null;
    this.startPromise = null;
    if (client) await client.stop();
  }

  getSessionId(): string | null { return this.sessionId; }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (!this.startPromise) this.startPromise = this.startClient();
    try {
      await this.startPromise;
    } catch (error) {
      this.fail(error);
      throw this.failure;
    } finally {
      this.startPromise = null;
    }
  }

  private async startClient(): Promise<void> {
    const workingDirectory = this.context.workingDirectory ?? process.cwd();
    const previousSessionId = this.sessionId;
    const client = new AcpProcessClient({
      command: this.profile.command,
      args: this.profile.args,
      workingDirectory,
      env: this.profile.env,
      label: `${this.profile.agentName} ACP`,
    });
    try {
      client.onEvent((event) => this.handleEvent(event));
      client.onRequest((request) => this.handleRequest(request));
      await client.start();
      this.client = client;

      const protocolVersion = this.profile.protocolVersion ?? ACP_PROTOCOL_VERSION;
      const init = await client.request("initialize", {
        protocolVersion,
        clientInfo: { name: "wingman-autopilot", version: "1.0.0" },
        clientCapabilities: {},
      });
      this.assertSuccess(init, "initialize");
      const negotiatedVersion = readProtocolVersion(init.result);
      if (negotiatedVersion !== null && negotiatedVersion !== protocolVersion) {
        throw new Error(`${this.profile.agentName} ACP negotiated unsupported protocol ${negotiatedVersion}`);
      }
      if (this.sessionId && !supportsSessionLoad(init.result)) {
        throw new Error(`${this.profile.agentName} ACP does not advertise session/load support`);
      }
      const sessionMethod = this.sessionId ? "session/load" : "session/new";
      const sessionParams = this.sessionId
        ? { sessionId: this.sessionId, cwd: workingDirectory, mcpServers: this.profile.mcpServers ?? [] }
        : { cwd: workingDirectory, mcpServers: this.profile.mcpServers ?? [] };
      const sessionResponse = await client.request(
        sessionMethod,
        sessionParams,
        sessionMethod === "session/load" ? { timeoutMs: null } : undefined,
      );
      this.assertSuccess(sessionResponse, sessionMethod);
      const returnedSessionId = readString(sessionResponse.result, "sessionId") ?? this.sessionId;
      if (!returnedSessionId) throw new Error(`${this.profile.agentName} ACP did not return a session ID`);
      this.sessionId = returnedSessionId;
      await this.profile.configureSession?.(client, returnedSessionId, sessionResponse);
      this.context.onNativeSessionId?.(returnedSessionId);
      this.setState("ready");
    } catch (error) {
      this.sessionId = previousSessionId;
      if (this.client === client) this.client = null;
      await client.stop().catch(() => {});
      const startupError = error instanceof Error ? error : new Error(String(error));
      throw this.profile.formatStartupError?.(startupError) ?? startupError;
    }
  }

  private handleEvent(event: AcpEvent): void {
    if (event.method === "process_exit") {
      if (this.state !== "disposed") this.fail(new Error(readString(event.params, "error") ?? `${this.profile.agentName} ACP process exited`));
      return;
    }
    if (event.method !== "session/update" && event.method !== "session/notification") return;
    const result = this.eventNormalizer.normalize(event.params?.update);
    if (result.kind === "ignored") return;
    if (result.kind === "invalid") {
      writeServerLog("WARN", `[${this.profile.agentName.toLowerCase()}-acp] ignored malformed session update: ${result.reason}`);
      return;
    }
    const messages = result.kind === "messages" ? result.messages : [result.message];
    for (const message of messages) {
      if (message.role === "user" && this.isActivePromptEcho(message)) continue;
      this.upsertMessage(message);
      this.emit({ type: "message", message });
    }
  }

  private handleRequest(request: AcpRequest): void {
    if (request.method !== "session/request_permission" && request.method !== "requestPermission") {
      this.requireClient().respondError(request.id, -32601, `Unsupported ${this.profile.agentName} ACP request: ${request.method}`);
      return;
    }
    const id = String(request.id);
    if (this.context.acpPermissionPolicy === "auto_approve") {
      const selected = selectAutoApprovalOption(request);
      if (selected) {
        this.requireClient().respond(request.id, {
          outcome: { outcome: "selected", optionId: selected.optionId },
        });
        this.materializeAutoApproval(id, selected);
        return;
      }
    }
    this.pendingPermissions.set(id, request);
    this.emit({ type: "permission", permission: this.toPermission(id, request) });
  }

  private materializeAutoApproval(
    id: string,
    selected: AgentPermissionOption,
  ): void {
    if (this.autoApprovedPermissionIds.has(id)) return;
    this.autoApprovedPermissionIds.add(id);
    const content = `ACP permission auto-approved: ${this.profile.agentName} runtime request (${selected.label}).`;
    if (this.profile.aggregateAutoApprovedPermissions) {
      const message = this.eventNormalizer.upsertToolActivity(`permission:${id}`, content);
      this.upsertMessage(message);
      this.emit({ type: "message", message });
      return;
    }
    const message: AgentMessage = {
      role: "agent-tools",
      content,
      createdAt: new Date().toISOString(),
      messageId: `acp-permission-${id}-auto-approved`,
      turnId: this.messages.at(-1)?.turnId,
      order: this.messages.at(-1)?.order !== undefined ? this.messages.at(-1)!.order! + 1 : undefined,
    };
    this.upsertMessage(message);
    this.emit({ type: "message", message });
  }

  private toPermission(id: string, request: AcpRequest): AgentPermission {
    const toolCall = readRecord(request.params?.toolCall);
    return {
      id,
      sessionId: this.context.id,
      type: `${this.profile.agentName.toLowerCase()}-acp-permission`,
      title: `${this.profile.agentName} requests permission`,
      pattern: readString(toolCall, "title") ?? undefined,
      options: readPermissionOptions(request),
      metadata: request.params ?? {},
      createdAt: new Date().toISOString(),
    };
  }

  private cancelPendingPermissions(): void {
    const client = this.requireClient();
    for (const request of this.pendingPermissions.values()) {
      client.respond(request.id, { outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  private assertSuccess(response: AcpResponse, method: string): void {
    if (!response.error) return;
    const data = response.error.data && typeof response.error.data === "object"
      ? response.error.data as Record<string, unknown>
      : null;
    const detail = typeof data?.details === "string" && data.details.trim()
      ? data.details.trim()
      : null;
    const message = response.error.message ?? "unknown error";
    throw new Error(
      `${this.profile.agentName} ACP ${method} failed: ${message}${detail && detail !== message ? `: ${detail}` : ""}`,
    );
  }

  private requireClient(): AcpProcessClient {
    if (!this.client) throw new Error(`${this.profile.agentName} ACP client is not ready`);
    return this.client;
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error(`${this.profile.agentName} ACP session ID is missing`);
    return this.sessionId;
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    if (this.state !== "disposed") this.state = "failed";
    this.emit({ type: "status", status: null });
  }

  private emit(event: AdapterStreamEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch { /* A disconnected consumer must not stop ACP processing. */ }
    }
  }

  private upsertMessage(message: AgentMessage): void {
    const index = message.messageId
      ? this.messages.findIndex((entry) => entry.messageId === message.messageId)
      : -1;
    if (index < 0) {
      this.messages = [...this.messages, message];
      return;
    }
    this.messages = [...this.messages.slice(0, index), message, ...this.messages.slice(index + 1)];
  }

  private isActivePromptEcho(message: AgentMessage): boolean {
    const activeContent = this.activePromptContent;
    if (!activeContent) return false;
    return activeContent.startsWith(message.content) || message.content.startsWith(activeContent);
  }

  private setState(nextState: AdapterState): void {
    if (this.state === nextState || this.state === "disposed" || this.state === "failed") return;
    this.state = nextState;
    this.emit({ type: "status", status: nextState === "busy" ? "running" : "stable" });
  }
}

function readPermissionOptions(request: AcpRequest): AgentPermissionOption[] {
  const rawOptions = Array.isArray(request.params?.options) ? request.params.options : [];
  const options: AgentPermissionOption[] = [];
  const responsePriorities = new Map<PermissionResponse, number>();

  for (const rawOption of rawOptions) {
    const option = readRecord(rawOption);
    const optionId = readString(option, "optionId");
    const response = resolvePermissionResponse(option);
    if (!optionId || !response) continue;
    const priority = permissionOptionPriority(option, response);
    const existingPriority = responsePriorities.get(response) ?? -1;
    if (existingPriority >= priority) continue;
    const normalized = {
      optionId,
      label: readString(option, "name") ?? permissionResponseLabel(response),
      response,
    };
    const existingIndex = options.findIndex((entry) => entry.response === response);
    if (existingIndex >= 0) options.splice(existingIndex, 1, normalized);
    else options.push(normalized);
    responsePriorities.set(response, priority);
  }

  return options;
}

function selectAutoApprovalOption(request: AcpRequest): AgentPermissionOption | null {
  const options = readPermissionOptions(request);
  return options.find((option) => option.response === "always")
    ?? options.find((option) => option.response === "once")
    ?? null;
}

function permissionOptionPriority(option: Record<string, unknown>, response: PermissionResponse): number {
  const kind = normalizePermissionToken(readString(option, "kind"));
  if (response === "reject" && kind === "reject_once") return 2;
  return 1;
}

function resolvePermissionResponse(option: Record<string, unknown>): PermissionResponse | null {
  const kind = normalizePermissionToken(readString(option, "kind"));
  if (kind === "allow_once") return "once";
  if (kind === "allow_always") return "always";
  if (kind === "reject_once" || kind === "reject_always") return "reject";

  const legacyToken = normalizePermissionToken(
    [readString(option, "optionId"), readString(option, "name")].filter(Boolean).join(" "),
  );
  if (legacyToken.includes("allow_once") || legacyToken.includes("once_allow")) return "once";
  if (legacyToken.includes("allow_always") || legacyToken.includes("always_allow")) return "always";
  if (legacyToken.includes("reject") || legacyToken.includes("deny")) return "reject";
  return null;
}

function normalizePermissionToken(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function permissionResponseLabel(response: PermissionResponse): string {
  if (response === "once") return "Allow once";
  if (response === "always") return "Always allow";
  return "Reject";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readProtocolVersion(value: unknown): string | number | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).protocolVersion;
  return typeof candidate === "string" || typeof candidate === "number" ? candidate : null;
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function supportsSessionLoad(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.loadSession === true) return true;
  const capabilities = result.agentCapabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  const data = capabilities as Record<string, unknown>;
  if (data.loadSession === true) return true;
  const sessions = data.sessionCapabilities;
  return Boolean(sessions && typeof sessions === "object" && ((sessions as Record<string, unknown>).load === true || (sessions as Record<string, unknown>).resume === true));
}
