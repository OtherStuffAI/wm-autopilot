import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Own the verified proxy process; never connect to an arbitrary configured URL. */
export class TinfoilProxy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Promise<string> | null = null;
  private endpoint: string | null = null;
  constructor(private readonly binary = process.env.TINFOIL_PROXY_CLI || Bun.which("tinfoil-proxy") || join(homedir(), ".local", "bin", "tinfoil-proxy")) {}
  async baseUrl(): Promise<string> {
    if (this.endpoint && this.child?.exitCode === null) return this.endpoint;
    if (this.pending) return this.pending;
    this.pending = this.start();
    try { return await this.pending; } finally { this.pending = null; }
  }
  private start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["--bind", "127.0.0.1", "--port", "0", "--handshake"], {
        stdio: ["pipe", "pipe", "pipe"],
        // Proxy receives no inherited provider credentials or broker capabilities.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SSL_CERT_FILE: process.env.SSL_CERT_FILE },
      });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => fail(), 60_000);
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill(); lines.close();
        reject(new Error("tinfoil_verified_proxy_unavailable"));
      };
      child.stderr.resume(); // Never copy untrusted process output into session logs.
      child.once("error", fail);
      child.once("exit", () => { this.endpoint = null; fail(); });
      lines.on("line", line => {
        if (settled || line.length > 1_000_000) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.event !== "ready") return;
        if (!/^127\.0\.0\.1:\d+$/.test(message.listen) || !message.verification_document) return fail();
        settled = true; clearTimeout(timer);
        this.endpoint = `http://${message.listen}/v1`;
        child.stdin.write("go\n");
        resolve(this.endpoint);
      });
    });
  }
  close(): void { this.child?.kill(); this.child = null; this.endpoint = null; }
}
