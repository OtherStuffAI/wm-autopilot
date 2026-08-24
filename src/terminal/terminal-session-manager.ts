import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import type { TerminalConfig } from "./terminal-config";
import { ensureNodePtyMacHelperExecutable } from "./node-pty-helper";

type NodePtyModule = typeof import("node-pty");

export interface TerminalSocket {
  sendText(data: string): void;
}

interface TerminalSession {
  pty?: IPty;
  bridge?: ChildProcessWithoutNullStreams;
}

export interface TerminalStartOptions {
  cols?: number;
  rows?: number;
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly config: TerminalConfig;
  private ptyModulePromise: Promise<NodePtyModule> | null = null;
  private availability: { available: boolean; error: string | null } | null = null;

  constructor(config: TerminalConfig) {
    this.config = config;
  }

  async checkAvailability(): Promise<{ available: boolean; error: string | null }> {
    if (this.availability) return this.availability;
    try {
      if (this.config.ptyMode === "bridge") {
        await this.checkBridgeAvailability();
      } else {
        await this.loadPtyModule();
      }
      this.availability = { available: true, error: null };
    } catch (error) {
      this.availability = {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.availability;
  }

  async start(connectionId: string, socket: TerminalSocket, options: TerminalStartOptions = {}): Promise<void> {
    this.close(connectionId);
    const cols = normalizeDimension(options.cols, 80, 20, 300);
    const rows = normalizeDimension(options.rows, 24, 8, 120);

    if (this.config.ptyMode === "bridge") {
      await this.startBridgeSession(connectionId, socket, cols, rows);
      return;
    }

    const ptyModule = await this.loadPtyModule();
    const pty = ptyModule.spawn(this.config.shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.config.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });

    this.sessions.set(connectionId, { pty });
    pty.onData((data) => {
      socket.sendText(JSON.stringify({ type: "output", data }));
    });
    pty.onExit(({ exitCode, signal }) => {
      socket.sendText(JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null }));
      this.sessions.delete(connectionId);
    });
  }

  write(connectionId: string, data: unknown): void {
    if (typeof data !== "string") return;
    const session = this.sessions.get(connectionId);
    if (session?.pty) {
      session.pty.write(data);
      return;
    }
    if (session?.bridge?.stdin.writable) {
      session.bridge.stdin.write(`${JSON.stringify({ type: "input", data })}\n`);
    }
  }

  resize(connectionId: string, cols: unknown, rows: unknown): void {
    const session = this.sessions.get(connectionId);
    if (!session || typeof cols !== "number" || typeof rows !== "number") return;
    const normalizedCols = normalizeDimension(cols, 80, 20, 300);
    const normalizedRows = normalizeDimension(rows, 24, 8, 120);
    if (session.bridge?.stdin.writable) {
      session.bridge.stdin.write(`${JSON.stringify({ type: "resize", cols: normalizedCols, rows: normalizedRows })}\n`);
      return;
    }
    if (!session.pty) return;
    try {
      session.pty.resize(
        normalizedCols,
        normalizedRows,
      );
    } catch {
      // Resize can race with process exit; the close handler will clean up.
    }
  }

  close(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    this.sessions.delete(connectionId);
    try {
      session.pty?.kill();
      session.bridge?.kill();
    } catch {
      // The PTY may already be gone.
    }
  }

  private async startBridgeSession(
    connectionId: string,
    socket: TerminalSocket,
    cols: number,
    rows: number,
  ): Promise<void> {
    await ensureNodePtyMacHelperExecutable();
    const bridgePath = new URL("./node-pty-bridge.cjs", import.meta.url).pathname;
    const bridge = spawnChild(process.env.TMAN_NODE_BIN || "node", [bridgePath], {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.sessions.set(connectionId, { bridge });

    let stdoutBuffer = "";
    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk) => {
      stdoutBuffer = processBridgeChunk(stdoutBuffer + chunk, socket);
    });
    bridge.stderr.setEncoding("utf8");
    bridge.stderr.on("data", (chunk) => {
      socket.sendText(JSON.stringify({ type: "error", message: String(chunk).trim() }));
    });
    bridge.on("exit", (code, signal) => {
      socket.sendText(JSON.stringify({ type: "exit", code: code ?? null, signal: signal ?? null }));
      this.sessions.delete(connectionId);
    });
    bridge.stdin.write(`${JSON.stringify({
      type: "start",
      shell: this.config.shell,
      cwd: this.config.cwd,
      cols,
      rows,
    })}\n`);
  }

  private async checkBridgeAvailability(): Promise<void> {
    await ensureNodePtyMacHelperExecutable();
    const bridgePath = new URL("./node-pty-bridge.cjs", import.meta.url).pathname;
    await new Promise<void>((resolve, reject) => {
      const bridge = spawnChild(process.env.TMAN_NODE_BIN || "node", [bridgePath], {
        cwd: this.config.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      bridge.stderr.setEncoding("utf8");
      bridge.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      bridge.on("error", reject);
      bridge.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Terminal PTY bridge unavailable: ${stderr.trim() || `exit ${code ?? "null"} signal ${signal ?? "null"}`}`));
      });
      bridge.stdin.end();
    });
  }

  private async loadPtyModule(): Promise<NodePtyModule> {
    if (!this.ptyModulePromise) {
      this.ptyModulePromise = ensureNodePtyMacHelperExecutable().then(() => import("node-pty"));
    }
    return await this.ptyModulePromise;
  }
}

function normalizeDimension(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function processBridgeChunk(input: string, socket: TerminalSocket): string {
  const lines = input.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      if (payload.type === "output" && typeof payload.data === "string") {
        socket.sendText(JSON.stringify({
          type: "output",
          data: Buffer.from(payload.data, "base64").toString("utf8"),
        }));
      } else if (payload.type === "exit") {
        socket.sendText(JSON.stringify({
          type: "exit",
          code: typeof payload.code === "number" ? payload.code : null,
          signal: typeof payload.signal === "number" || typeof payload.signal === "string" ? payload.signal : null,
        }));
      } else if (payload.type === "error" && typeof payload.message === "string") {
        socket.sendText(JSON.stringify({ type: "error", message: payload.message }));
      }
    } catch {
      socket.sendText(JSON.stringify({ type: "error", message: "Invalid terminal bridge message" }));
    }
  }
  return remainder;
}
