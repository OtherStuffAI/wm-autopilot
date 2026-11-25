import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseTinfoilReady, TinfoilProxyError, type TinfoilVerification } from "./tinfoil-verification";

export { TinfoilProxyError } from "./tinfoil-verification";

const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_LINE = 1_000_000;
const MAX_HANDSHAKE_OUTPUT = 4_000_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface TinfoilProxyOptions {
  binary?: string;
  /** Operator-approved SHA-256 of the proxy binary. Absent or malformed fails closed. */
  sha256?: string;
  handshakeTimeoutMs?: number;
  now?: () => number;
}
interface LiveProxy { child: ChildProcessWithoutNullStreams; endpoint: string; expiresAtMs: number; verification: TinfoilVerification; alive: () => boolean }

/**
 * Own the verified proxy process. The only endpoint ever returned comes from a pinned binary this class spawned,
 * whose strict `ready` summary was validated, while that same child is alive and its attestation unexpired.
 */
export class TinfoilProxy {
  private live: LiveProxy | null = null;
  private starting: ChildProcessWithoutNullStreams | null = null;
  private pending: Promise<LiveProxy> | null = null;
  private generation = 0;
  private readonly binary: string;
  private readonly sha256: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  constructor(options: TinfoilProxyOptions = {}) {
    this.binary = options.binary ?? (process.env.TINFOIL_PROXY_CLI || Bun.which("tinfoil-proxy") || join(homedir(), ".local", "bin", "tinfoil-proxy"));
    this.sha256 = (options.sha256 ?? process.env.TINFOIL_PROXY_SHA256 ?? "").trim().toLowerCase();
    this.timeoutMs = options.handshakeTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }
  /** Fresh on every call: a dead, closed or expired proxy is replaced by a newly verified one, never reused. */
  async baseUrl(): Promise<string> {
    if (this.live) {
      if (this.usable(this.live)) return this.live.endpoint;
      this.retire();
    }
    this.pending ??= this.start().finally(() => { this.pending = null; });
    const live = await this.pending;
    if (!this.usable(live)) throw new TinfoilProxyError("proxy_unavailable");
    return live.endpoint;
  }
  /** Verified attestation summary of the current proxy, for evidence; null when not usable. */
  verification(): TinfoilVerification | null { return this.live && this.usable(this.live) ? this.live.verification : null; }
  close(): void {
    this.generation++;
    this.starting?.kill(); this.starting = null;
    this.retire();
  }
  private usable(live: LiveProxy): boolean { return live === this.live ? live.alive() && this.now() < live.expiresAtMs : false; }
  private retire(): void { this.live?.child.kill(); this.live = null; }
  private async readPinnedBinary(): Promise<void> {
    if (!SHA256_HEX.test(this.sha256)) throw new TinfoilProxyError("binary_unpinned");
    const file = Bun.file(this.binary);
    let bytes: Uint8Array;
    try {
      if (!(await file.exists()) || file.size > MAX_BINARY_BYTES) throw new Error("unreadable");
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch { throw new TinfoilProxyError("proxy_unavailable"); }
    if (createHash("sha256").update(bytes).digest("hex") !== this.sha256) throw new TinfoilProxyError("binary_unpinned");
  }
  private async start(): Promise<LiveProxy> {
    const generation = this.generation;
    await this.readPinnedBinary();
    if (generation !== this.generation) throw new TinfoilProxyError("proxy_unavailable");
    const child = spawn(this.binary, ["--bind", "127.0.0.1", "--port", "0", "--handshake"], {
      stdio: ["pipe", "pipe", "pipe"],
      // Proxy receives no inherited provider credentials or broker capabilities.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SSL_CERT_FILE: process.env.SSL_CERT_FILE },
    });
    this.starting = child;
    try {
      const live = await this.handshake(child);
      if (generation !== this.generation) { child.kill(); throw new TinfoilProxyError("proxy_unavailable"); }
      this.live = live;
      return live;
    } finally { if (this.starting === child) this.starting = null; }
  }
  private handshake(child: ChildProcessWithoutNullStreams): Promise<LiveProxy> {
    return new Promise((resolve, reject) => {
      let settled = false; let exited = false; let buffer = ""; let total = 0;
      const fail = (code: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child.stdin.write("abort\n"); child.kill();
        reject(new TinfoilProxyError(code));
      };
      const timer = setTimeout(() => fail("handshake_timeout"), this.timeoutMs);
      child.stdin.on("error", () => {}); // Output of an untrusted process is never copied into logs or errors.
      child.stderr.resume();
      child.once("error", () => { exited = true; fail("proxy_unavailable"); });
      child.once("exit", () => { exited = true; fail("proxy_unavailable"); });
      const alive = () => !exited && child.exitCode === null && child.signalCode === null;
      const accept = (line: string) => {
        let message: unknown;
        try { message = JSON.parse(line); } catch { return; }
        if (!message || typeof message !== "object" || (message as { event?: unknown }).event !== "ready") return;
        try {
          const ready = parseTinfoilReady(message as Record<string, unknown>, this.now());
          settled = true; clearTimeout(timer);
          child.stdin.write("go\n");
          resolve({ child, alive, endpoint: `http://${ready.listen}/v1`, expiresAtMs: ready.expiresAtMs, verification: ready.verification });
        } catch (error) { fail(error instanceof TinfoilProxyError ? error.code : "verification_invalid"); }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return; // After release, keep draining and discard.
        total += chunk.length; buffer += chunk;
        if (total > MAX_HANDSHAKE_OUTPUT) return fail("handshake_oversize");
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.length > MAX_LINE) return fail("handshake_oversize");
          accept(line);
        }
        if (!settled && buffer.length > MAX_LINE) fail("handshake_oversize");
      });
    });
  }
}
