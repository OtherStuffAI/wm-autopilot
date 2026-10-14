import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { NodePtySession } from "./node-pty-session";
import { TerminalSessionManager } from "./terminal-session-manager";

const config = { shell: "/bin/sh", cwd: "/tmp", ptyMode: "bridge" as const, ticketTtlMs: 30000 };
function fakeHelper(timeoutMs = 1000) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed += 1; } });
  let killed = 0;
  let ended = 0;
  const messages: Array<Record<string, any>> = [];
  const session = new NodePtySession({ timeoutMs, spawnChild: (() => child) as any, onEnd: () => { ended += 1; } });
  const start = () => session.start(config, { sendText: (value) => messages.push(JSON.parse(value)) }, 80, 24);
  return { child, session, start, messages, killed: () => killed, ended: () => ended };
}

describe("PTY helper lifecycle", () => {
  test("waits for helper ready and forwards input/output; emits exit once", async () => {
    const h = fakeHelper();
    let ready = false;
    const start = h.start().then(() => { ready = true; });
    await Bun.sleep(1);
    expect(ready).toBe(false);
    h.child.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
    await start;
    expect(ready).toBe(true);
    h.child.stdin.read();
    h.session.write("pwd\r");
    expect(String(h.child.stdin.read())).toContain(`"type":"input"`);
    h.child.stdout.write(JSON.stringify({ type: "output", data: Buffer.from("/tmp").toString("base64") }) + "\n");
    expect(h.messages).toEqual([{ type: "output", data: "/tmp" }]);
    h.child.stdout.write(`${JSON.stringify({ type: "exit", code: 0 })}\n`);
    h.child.emit("exit", 0, null);
    expect(h.messages.filter((p) => p.type === "exit")).toHaveLength(1);
    expect(h.ended()).toBe(1);
    expect(h.killed()).toBe(1);
  });

  test("rejects missing helper, premature exit and reported startup failure", async () => {
    for (const mode of ["spawn-error", "exit", "error-message"]) {
      const h = fakeHelper();
      const pending = h.start().catch((error) => error);
      if (mode === "spawn-error") h.child.emit("error", new Error("ENOENT"));
      else if (mode === "exit") { h.child.stderr.write("module missing"); h.child.emit("exit", 1, null); }
      else h.child.stdout.write(`${JSON.stringify({ type: "error", message: "PTY spawn failed" })}\n`);
      expect((await pending).message).toContain("Terminal");
      expect(h.killed()).toBe(1);
      expect(h.ended()).toBe(1);
      expect(h.messages).toEqual([]);
    }
  });

  test("timeout and disconnect reject pending startup and suppress late helper events", async () => {
    const timeout = fakeHelper(5);
    await expect(timeout.start()).rejects.toThrow("timed out");
    expect(timeout.killed()).toBe(1);
    const cancelled = fakeHelper();
    const pending = cancelled.start().catch((error) => error);
    cancelled.session.close();
    expect((await pending).message).toContain("cancelled");
    cancelled.child.stdout.write(`{"type":"ready"}\n{"type":"output","data":"eA=="}\n`);
    cancelled.child.emit("exit", 0, null);
    expect(cancelled.messages).toEqual([]);
    expect(cancelled.killed()).toBe(1);
  });

  test("manager disconnect before asynchronous launch validation cancels shell creation", async () => {
    const manager = new TerminalSessionManager(config);
    const pending = manager.start("cancel-before-spawn", { sendText: () => { throw new Error("Unexpected socket output"); } });
    manager.close("cancel-before-spawn");
    await expect(pending).rejects.toThrow("cancelled");
  });
});
