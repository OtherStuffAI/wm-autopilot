import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export interface AcpProcessClientOptions {
  command: string;
  args?: string[];
  workingDirectory: string;
  env: Record<string, string>;
  label: string;
  requestTimeoutMs?: number;
  startupDelayMs?: number;
}

export interface AcpEvent {
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpRequestOptions {
  /** Override the client default. Null disables the deadline for long-running ACP operations. */
  timeoutMs?: number | null;
}

interface PendingRequest {
  resolve: (response: AcpResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_DELAY_MS = 100;

export class AcpProcessClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineReader: ReadLineInterface | null = null;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly eventListeners = new Set<(event: AcpEvent) => void>();
  private readonly requestListeners = new Set<(request: AcpRequest) => void>();
  private stderr = "";
  private processFailure: Error | null = null;
  private nextRequestId = 1;

  constructor(private readonly options: AcpProcessClientOptions) {}

  async start(): Promise<void> {
    if (this.process) return;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.workingDirectory,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw this.wrapProcessError(error);
    }
    child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    child.once("error", (error) => this.handleProcessError(error));
    child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    this.lineReader = createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));
    this.process = child;

    await new Promise((resolve) => setTimeout(resolve, this.options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS));
    if (this.processFailure) throw this.processFailure;
    if (child.exitCode !== null) {
      throw new Error(this.processError(child.exitCode, null));
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.lineReader?.close();
    this.lineReader = null;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
  }

  onEvent(listener: (event: AcpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onRequest(listener: (request: AcpRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: AcpRequestOptions,
  ): Promise<AcpResponse> {
    if (!this.process?.stdin.writable) throw new Error(`${this.options.label} process is not running`);
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs === undefined
        ? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        : options.timeoutMs;
      const timeout = timeoutMs === null
        ? null
        : setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Timed out waiting for ${this.options.label} ${method}`));
        }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) throw new Error(`${this.options.label} process is not running`);
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.process?.stdin.writable) {
      throw new Error(`${this.options.label} process is not running`);
    }
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (!this.process?.stdin.writable) return;
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  getStderr(): string { return this.stderr; }

  private write(payload: Record<string, unknown>): void {
    this.process!.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
    const id = typeof payload.id === "number" || typeof payload.id === "string" ? payload.id : undefined;
    if (id !== undefined && (payload.result !== undefined || payload.error !== undefined)) {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(payload as AcpResponse);
      return;
    }
    if (id !== undefined && typeof payload.method === "string") {
      for (const listener of this.requestListeners) listener({
        id,
        method: payload.method,
        params: isRecord(payload.params) ? payload.params : undefined,
      });
      return;
    }
    if (typeof payload.method === "string") {
      for (const listener of this.eventListeners) listener({
        method: payload.method,
        params: isRecord(payload.params) ? payload.params : undefined,
      });
    }
  }

  private handleProcessError(error: Error): void {
    const wrapped = this.wrapProcessError(error);
    this.processFailure = wrapped;
    this.failPending(wrapped);
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(this.processError(code, signal));
    this.processFailure = error;
    this.failPending(error);
    for (const listener of this.eventListeners) {
      listener({ method: "process_exit", params: { code, signal, stderr: this.stderr, error: error.message } });
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.process = null;
    this.lineReader?.close();
    this.lineReader = null;
  }

  private wrapProcessError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${this.options.label} process failed to start: ${message}`);
  }

  private processError(code: number | null, signal: NodeJS.Signals | null): string {
    return `${this.options.label} process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}${this.stderr ? `: ${this.stderr.trim()}` : ""}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
