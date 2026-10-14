import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TerminalConfig } from "./terminal-config";
import type { TerminalSocket } from "./terminal-session-manager";

const START_TIMEOUT_MS = 10_000;

interface NodePtySessionOptions {
  spawnChild?: typeof spawn;
  timeoutMs?: number;
  onEnd?: () => void;
}

/** The helper must acknowledge a successful PTY spawn before the socket is ready. */
export class NodePtySession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelled = false;
  constructor(private readonly options: NodePtySessionOptions = {}) {}

  private rejectStart: ((error: Error) => void) | null = null;

  async start(config: TerminalConfig, socket: TerminalSocket, cols: number, rows: number): Promise<void> {
    if (this.cancelled) throw new Error("Terminal startup cancelled");
    const bridgePath = new URL("./node-pty-bridge.cjs", import.meta.url).pathname;
    const child = (this.options.spawnChild ?? spawn)(process.env.TMAN_NODE_BIN || "node", [bridgePath], {
      cwd: config.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let ended = false;
      let buffer = "";
      let stderr = "";
      const timer = setTimeout(() => fail("Terminal PTY helper timed out before shell startup"), this.options.timeoutMs ?? START_TIMEOUT_MS);
      const fail = (message: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        this.rejectStart = null;
        if (ready) socket.sendText(JSON.stringify({ type: "error", phase: "shell", message }));
        else reject(new Error(message));
        this.close();
      };
      this.rejectStart = (error) => fail(error.message);
      child.on("error", (error) => fail(`Terminal PTY helper failed: ${error.message}`));
      child.stdin.on("error", (error) => fail(`Terminal PTY helper input failed: ${error.message}`));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (ended || this.cancelled || !line.trim()) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(line); } catch { fail("Invalid terminal PTY helper message"); continue; }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            fail("Invalid terminal PTY helper message");
            continue;
          }
          if (payload.type === "ready" && !ready) {
            ready = true;
            clearTimeout(timer);
            this.rejectStart = null;
            resolve();
          } else if (payload.type === "error") {
            fail(`Terminal shell startup failed: ${typeof payload.message === "string" ? payload.message : "Unknown helper error"}`);
          } else if (payload.type === "output" && ready && typeof payload.data === "string") {
            socket.sendText(JSON.stringify({ type: "output", data: Buffer.from(payload.data, "base64").toString("utf8") }));
          } else if (payload.type === "exit") {
            if (!ready) { fail("Terminal shell exited before startup completed"); continue; }
            ended = true;
            socket.sendText(JSON.stringify(payload));
            this.close();
          } else {
            fail("Unexpected terminal PTY helper message before shell readiness");
          }
        }
      });
      child.on("exit", (code, signal) => {
        if (ended || this.cancelled) return;
        if (!ready) { fail(`Terminal PTY helper exited before shell startup: ${stderr.trim() || `exit ${code}, signal ${signal}`}`); return; }
        ended = true;
        socket.sendText(JSON.stringify({ type: "exit", code, signal }));
        this.close();
      });
      child.stdin.write(`${JSON.stringify({ type: "start", shell: config.shell, cwd: config.cwd, cols, rows })}\n`);
    });
  }

  write(data: string): void { this.send({ type: "input", data }); }
  resize(cols: number, rows: number): void { this.send({ type: "resize", cols, rows }); }

  close(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.options.onEnd?.();
    const reject = this.rejectStart;
    this.rejectStart = null;
    reject?.(new Error("Terminal startup cancelled"));
    this.child?.kill();
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.cancelled && this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
