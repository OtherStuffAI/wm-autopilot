import { spawn as spawnChild } from "node:child_process";
import { validateTerminalLaunch } from "./terminal-launch";
import { NodePtySession } from "./node-pty-session";
import type { IPty } from "node-pty";
import type { TerminalConfig } from "./terminal-config";
import { ensureNodePtyMacHelperExecutable } from "./node-pty-helper";

type NodePtyModule = typeof import("node-pty");

export interface TerminalSocket {
  sendText(data: string): void;
}

interface TerminalSession {
  pty?: IPty;
  bridge?: NodePtySession;
  cancelled?: boolean;
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
      await validateTerminalLaunch(this.config);
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

    const session: TerminalSession = {};
    this.sessions.set(connectionId, session);
    try {
      const launchConfig = await validateTerminalLaunch(this.config);
      if (session.cancelled) throw new Error("Terminal startup cancelled");
      if (this.config.ptyMode === "bridge") {
        const bridge = new NodePtySession({ onEnd: () => {
          session.cancelled = true;
          if (this.sessions.get(connectionId) === session) this.sessions.delete(connectionId);
        } });
        session.bridge = bridge;
        await ensureNodePtyMacHelperExecutable();
        if (session.cancelled) throw new Error("Terminal startup cancelled");
        await bridge.start(launchConfig, socket, cols, rows);
        if (session.cancelled) throw new Error("Terminal shell exited during startup");
        return;
      }

      const ptyModule = await this.loadPtyModule();
      if (session.cancelled) throw new Error("Terminal startup cancelled");
      const pty = ptyModule.spawn(launchConfig.shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: this.config.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
        },
      });

      session.pty = pty;
      pty.onData((data) => {
        if (session.cancelled) return;
        socket.sendText(JSON.stringify({ type: "output", data }));
      });
      pty.onExit(({ exitCode, signal }) => {
        if (session.cancelled) return;
        socket.sendText(JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null }));
        if (this.sessions.get(connectionId) === session) this.sessions.delete(connectionId);
      });
    } catch (error) {
      if (this.sessions.get(connectionId) === session) this.close(connectionId);
      throw error;
    }
  }

  write(connectionId: string, data: unknown): void {
    if (typeof data !== "string") return;
    const session = this.sessions.get(connectionId);
    if (session?.pty) {
      session.pty.write(data);
      return;
    }
    session?.bridge?.write(data);
  }

  resize(connectionId: string, cols: unknown, rows: unknown): void {
    const session = this.sessions.get(connectionId);
    if (!session || typeof cols !== "number" || typeof rows !== "number") return;
    const normalizedCols = normalizeDimension(cols, 80, 20, 300);
    const normalizedRows = normalizeDimension(rows, 24, 8, 120);
    if (session.bridge) {
      session.bridge.resize(normalizedCols, normalizedRows);
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
    session.cancelled = true;
    try {
      session.pty?.kill();
      session.bridge?.close();
    } catch {
      // The PTY may already be gone.
    }
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
