import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export interface PiRpcClientOptions {
  cliPath: string;
  workingDirectory: string;
  sessionDirectory: string;
  continueSession?: boolean;
  env: Record<string, string>;
  model?: string;
}

export interface PiRpcResponse {
  id?: number;
  type: "response";
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const RPC_REQUEST_TIMEOUT_MS = 10000;
const RPC_STARTUP_DELAY_MS = 100;

export function buildPiRpcArgs(options: Pick<PiRpcClientOptions, "sessionDirectory" | "continueSession" | "model">): string[] {
  return [
    ...(options.model ? ["--model", options.model] : []),
    "--mode",
    "rpc",
    "--session-dir",
    options.sessionDirectory,
    ...(options.continueSession ? ["--continue"] : []),
  ];
}

export class PiRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineReader: ReadLineInterface | null = null;
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private stderr = "";
  private nextRequestId = 1;

  constructor(private readonly options: PiRpcClientOptions) {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const args = buildPiRpcArgs(this.options);
    const child = spawn(this.options.cliPath, args, {
      cwd: this.options.workingDirectory,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    child.once("exit", (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    this.lineReader = createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    this.process = child;
    await new Promise((resolve) => setTimeout(resolve, RPC_STARTUP_DELAY_MS));
    if (child.exitCode !== null) {
      throw new Error(
        `Pi RPC process exited immediately with code ${child.exitCode}${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
      );
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    this.lineReader?.close();
    this.lineReader = null;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill("SIGKILL");
        }
        resolve();
      }, 1000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async prompt(message: string): Promise<PiRpcResponse> {
    return this.sendCommand({ type: "prompt", message });
  }

  async abort(): Promise<PiRpcResponse> {
    return this.sendCommand({ type: "abort" });
  }

  getStderr(): string {
    return this.stderr;
  }

  private sendCommand(command: Record<string, unknown>): Promise<PiRpcResponse> {
    const child = this.process;
    if (!child || !child.stdin.writable) {
      throw new Error("Pi RPC process is not running");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response to ${String(command.type)}`));
      }, RPC_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (payload.type === "response") {
      this.handleResponse(payload as unknown as PiRpcResponse);
      return;
    }

    this.emitEvent(payload as PiRpcEvent);
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = typeof response.id === "number" ? response.id : null;
    if (id === null) {
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);

    if (response.success) {
      pending.resolve(response);
      return;
    }

    pending.reject(new Error(response.error || `Pi RPC ${response.command || "request"} failed`));
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new Error(
      `Pi RPC process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
    );

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    this.process = null;
    this.lineReader?.close();
    this.lineReader = null;

    this.emitEvent({
      type: "process_exit",
      code,
      signal,
      stderr: this.stderr,
    });
  }

  private emitEvent(event: PiRpcEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Listener failures should not break the RPC stream.
      }
    }
  }
}
