import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentAdapter, AdapterSessionContext, AdapterStreamEvent, PromptReadiness } from "./agent-adapter";
import type { AgentRuntimeStatus } from "../types/agent-status";
import type { AgentMessage, AgentReadyOptions } from "./agent-client";
import { PiRpcClient, type PiRpcEvent } from "./pi-rpc-client";
import {
  normalizePiRuntimeMessages,
  normalizePiStreamingMessage,
  parsePiSessionMessages,
  type PiSessionMessage,
} from "./pi-session-messages";

type AdapterState = "initializing" | "ready" | "busy" | "disposed";

interface DeferredTurn {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_PI_CLI = "pi";
const PI_STARTUP_MESSAGE = "Pi session started. Send a message to begin.";
const PI_STARTUP_CREATED_AT = "1970-01-01T00:00:00.000Z";
const PI_BUSY_SESSION_FILE_RETRY_MS = 40;
const PI_BUSY_SESSION_FILE_RETRY_ATTEMPTS = 5;
const PI_AGENT_END_SETTLE_MS = 75;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { parsePiSessionMessages } from "./pi-session-messages";

function buildPiEnv(context: AdapterSessionContext): Record<string, string> {
  const env = {
    ...(process.env as Record<string, string>),
    ...(context.env ?? {}),
  };

  if (!env.OPENROUTER_API_KEY && env.OPENROUTER_API) {
    env.OPENROUTER_API_KEY = env.OPENROUTER_API;
  }

  return env;
}

function createStartupMessages(): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: PI_STARTUP_MESSAGE,
      createdAt: PI_STARTUP_CREATED_AT,
    },
  ];
}

function createDeferredTurn(): DeferredTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function readPiEventType(event: PiRpcEvent): string {
  return typeof event.type === "string" ? event.type : "";
}

function readPiEventMessage(event: PiRpcEvent): PiSessionMessage | null {
  const message = event.message;
  if (!message || typeof message !== "object") {
    return null;
  }
  return message as PiSessionMessage;
}

function readPiEventMessages(event: PiRpcEvent): PiSessionMessage[] {
  return Array.isArray(event.messages)
    ? event.messages.filter((message): message is PiSessionMessage => Boolean(message && typeof message === "object"))
    : [];
}

export class PiAdapter implements AgentAdapter {
  private readonly workingDirectory: string;
  private readonly sessionDirectory: string;
  private readonly piCommand: string;
  private readonly env: Record<string, string>;
  private state: AdapterState = "initializing";
  private messages: AgentMessage[] = [];
  private readonly eventListeners = new Set<(event: AdapterStreamEvent) => void>();
  private rpcClient: PiRpcClient | null = null;
  private startPromise: Promise<void> | null = null;
  private currentTurn: DeferredTurn | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private clientUnsubscribe: (() => void) | null = null;

  constructor(private readonly context: AdapterSessionContext) {
    this.workingDirectory = context.workingDirectory ?? process.cwd();
    this.sessionDirectory = join(process.env.HOME ?? homedir(), ".wingmen", "pi-sessions", context.id);
    this.piCommand = context.env?.PI_CLI || process.env.PI_CLI || DEFAULT_PI_CLI;
    this.env = buildPiEnv(context);
  }

  async fetchStatus(_timeoutMs?: number): Promise<AgentRuntimeStatus | null> {
    if (this.state === "disposed") {
      return null;
    }
    return this.state === "busy" ? "running" : "stable";
  }

  async getPromptReadiness(_timeoutMs?: number): Promise<PromptReadiness> {
    const observedAt = Date.now();
    if (this.state === "disposed") {
      return { state: "unreachable", reason: "pi-disposed", retryAfterMs: 5000, observedAt };
    }
    if (this.state === "initializing") {
      return { state: "starting", reason: "pi-initializing", retryAfterMs: 1000, observedAt };
    }
    if (this.state === "busy" || this.currentTurn) {
      return { state: "busy", reason: "pi-active-turn", retryAfterMs: 1000, observedAt };
    }
    return { state: "ready", reason: "pi-ready", retryAfterMs: 250, observedAt };
  }

  deliversPromptsDirectly(): boolean {
    return true;
  }

  async sendMessage(content: string, _type = "user"): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("PiAdapter has been disposed");
    }

    await this.waitForReady();
    const client = await this.ensureClient();
    const turn = this.beginTurn();

    try {
      await client.prompt(content);
      await turn.promise;
      await this.reloadMessages(false);
    } catch (error) {
      if (this.currentTurn === turn) {
        this.currentTurn = null;
      }
      this.setState("ready");
      throw error;
    }
  }

  async fetchMessages(): Promise<AgentMessage[]> {
    await this.waitForReady();
    await this.reloadMessages(false);
    return this.messages;
  }

  async interruptCurrentTurn(): Promise<boolean> {
    const client = this.rpcClient;
    if (!client || this.state !== "busy") {
      return false;
    }
    await client.abort();
    return true;
  }

  getEventsUrl(): URL | null {
    return null;
  }

  subscribeToEvents(listener: (event: AdapterStreamEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async waitForReady(options?: AgentReadyOptions): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("PiAdapter has been disposed");
    }

    await mkdir(this.sessionDirectory, { recursive: true });
    await this.ensureClient();

    const timeoutMs = options?.timeoutMs ?? 30000;
    const pollMs = options?.pollIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    while (this.state === "busy" && Date.now() < deadline) {
      await sleep(pollMs);
    }
    if (this.state === "busy") {
      throw new Error(`PiAdapter not ready after ${timeoutMs}ms`);
    }
  }

  async dispose(): Promise<void> {
    this.clearFinishTimer();
    if (this.currentTurn) {
      this.currentTurn.reject(new Error("PiAdapter has been disposed"));
      this.currentTurn = null;
    }
    this.state = "disposed";
    this.clientUnsubscribe?.();
    this.clientUnsubscribe = null;
    const client = this.rpcClient;
    this.rpcClient = null;
    this.startPromise = null;
    if (client) {
      await client.stop();
    }
  }

  private async ensureClient(): Promise<PiRpcClient> {
    if (this.rpcClient) {
      return this.rpcClient;
    }
    if (this.startPromise) {
      await this.startPromise;
      if (!this.rpcClient) {
        throw new Error("Pi RPC client failed to start");
      }
      return this.rpcClient;
    }

    this.startPromise = this.startClient();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }

    if (!this.rpcClient) {
      throw new Error("Pi RPC client failed to start");
    }
    return this.rpcClient;
  }

  private async startClient(): Promise<void> {
    const client = new PiRpcClient({
      cliPath: this.piCommand,
      workingDirectory: this.workingDirectory,
      sessionDirectory: this.sessionDirectory,
      continueSession: await this.hasExistingSessionFile(),
      env: this.env,
      model: this.context.model,
    });

    await client.start();
    this.clientUnsubscribe = client.onEvent((event) => {
      void this.handleRpcEvent(event);
    });
    this.rpcClient = client;

    await this.reloadMessages(false);
    if (this.state !== "busy" && this.state !== "disposed") {
      this.setState("ready");
    }
  }

  private beginTurn(): DeferredTurn {
    this.clearFinishTimer();
    if (this.currentTurn) {
      this.currentTurn.reject(new Error("PiAdapter started a new turn before the previous turn completed"));
    }
    const turn = createDeferredTurn();
    this.currentTurn = turn;
    this.setState("busy");
    return turn;
  }

  private finishTurn(error?: Error): void {
    this.clearFinishTimer();
    const turn = this.currentTurn;
    this.currentTurn = null;
    if (this.state !== "disposed") {
      this.setState("ready");
    }
    if (!turn) {
      return;
    }
    if (error) {
      turn.reject(error);
      return;
    }
    turn.resolve();
  }

  private scheduleFinishTurn(): void {
    this.clearFinishTimer();
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      this.finishTurn();
    }, PI_AGENT_END_SETTLE_MS);
  }

  private clearFinishTimer(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
  }

  private async handleRpcEvent(event: PiRpcEvent): Promise<void> {
    const eventType = readPiEventType(event);
    if (!eventType || this.state === "disposed") {
      return;
    }

    if (eventType === "process_exit") {
      this.rpcClient = null;
      this.clientUnsubscribe?.();
      this.clientUnsubscribe = null;
      const stderr = typeof event.stderr === "string" ? event.stderr.trim() : "";
      this.finishTurn(new Error(stderr || "Pi RPC process exited unexpectedly"));
      this.state = "initializing";
      return;
    }

    if (eventType === "agent_start" || eventType === "turn_start") {
      this.clearFinishTimer();
      this.setState("busy");
      return;
    }

    if (eventType === "message_start" || eventType === "message_update" || eventType === "message_end") {
      const message = readPiEventMessage(event);
      if (message) {
        this.upsertRuntimeMessage(message);
      }
      return;
    }

    if (eventType === "turn_end") {
      const messages = readPiEventMessages(event);
      if (messages.length > 0) {
        this.replaceMessages(normalizePiRuntimeMessages(messages), true);
      }
      this.scheduleFinishTurn();
      return;
    }

    if (eventType === "agent_end") {
      const messages = readPiEventMessages(event);
      if (messages.length > 0) {
        this.replaceMessages(normalizePiRuntimeMessages(messages), true);
      } else {
        await this.reloadMessages(true);
      }
      this.finishTurn();
    }
  }

  private upsertRuntimeMessage(rawMessage: PiSessionMessage): void {
    const message = normalizePiStreamingMessage(rawMessage);
    if (!message) {
      return;
    }

    const existingIndex = this.messages.findIndex((entry) => {
      return entry.role === message.role && entry.createdAt === message.createdAt;
    });

    if (existingIndex >= 0) {
      const existing = this.messages[existingIndex]!;
      if (existing.content === message.content) {
        return;
      }
      this.messages[existingIndex] = message;
    } else {
      this.messages = [...this.messages, message];
    }

    this.emitEvent({ type: "message", message });
  }

  private replaceMessages(nextMessages: AgentMessage[], emitChanges: boolean): void {
    const messages = nextMessages.length > 0 ? nextMessages : createStartupMessages();
    const previousMessages = this.messages;
    this.messages = messages;

    if (!emitChanges) {
      return;
    }

    const maxLength = Math.max(previousMessages.length, messages.length);
    for (let index = 0; index < maxLength; index += 1) {
      const previous = previousMessages[index];
      const next = messages[index];
      if (!next) {
        continue;
      }
      if (!previous || previous.role !== next.role || previous.content !== next.content || previous.createdAt !== next.createdAt) {
        this.emitEvent({ type: "message", message: next });
      }
    }
  }

  private emitEvent(event: AdapterStreamEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Listener failures should not break the adapter.
      }
    }
  }

  private setState(nextState: AdapterState): void {
    if (this.state === nextState || this.state === "disposed") {
      return;
    }
    this.state = nextState;
    const runtimeStatus: AgentRuntimeStatus | null = nextState === "busy" ? "running" : "stable";
    this.emitEvent({ type: "status", status: runtimeStatus });
  }

  private async hasExistingSessionFile(): Promise<boolean> {
    const file = await this.findLatestSessionFile();
    return Boolean(file);
  }

  private async findLatestSessionFile(): Promise<string | null> {
    try {
      const entries = await readdir(this.sessionDirectory, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
        .sort();
      const latest = files.length > 0 ? files[files.length - 1] : null;
      return latest ? join(this.sessionDirectory, latest) : null;
    } catch {
      return null;
    }
  }

  private async reloadMessages(emitChanges: boolean): Promise<void> {
    let sessionFile = await this.findLatestSessionFile();
    if (!sessionFile && this.state === "busy") {
      for (let attempt = 0; attempt < PI_BUSY_SESSION_FILE_RETRY_ATTEMPTS && !sessionFile; attempt += 1) {
        await sleep(PI_BUSY_SESSION_FILE_RETRY_MS);
        sessionFile = await this.findLatestSessionFile();
      }
    }

    if (!sessionFile) {
      this.replaceMessages(createStartupMessages(), emitChanges);
      return;
    }

    const content = await readFile(sessionFile, "utf8");
    const parsedMessages = parsePiSessionMessages(content);
    this.replaceMessages(parsedMessages, emitChanges);
  }
}
