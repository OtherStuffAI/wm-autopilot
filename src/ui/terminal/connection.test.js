import { describe, expect, test } from "bun:test";
import { bindTerminalConnection } from "./connection.js";

function harness(timeoutMs = 1000) {
  const events = {};
  const sent = [];
  const status = [];
  const lines = [];
  let active = true;
  const socket = {
    readyState: 1,
    send: (value) => sent.push(JSON.parse(value)),
    close() { this.readyState = 3; events.close?.({ code: 1000 }); },
    addEventListener: (name, callback) => { events[name] = callback; },
  };
  const terminal = { cols: 90, rows: 30, writeln: (text) => lines.push(text), write: (text) => lines.push(text), focus() {} };
  const connection = bindTerminalConnection({ socket, terminal, timeoutMs, isCurrent: () => active, onStatus: (message, details) => status.push({ message, ...details }) });
  return { connection, sent, status, lines, emit: (name, value) => events[name]?.(value), deactivate: () => { active = false; } };
}

describe("terminal connection reporting", () => {
  test("starts once open, enables input only after ready, and reports output", () => {
    const h = harness();
    h.connection.send({ type: "input", data: "ignored" });
    h.emit("open");
    expect(h.sent).toEqual([{ type: "start", cols: 90, rows: 30 }]);
    h.emit("message", { data: JSON.stringify({ type: "ready" }) });
    h.connection.send({ type: "input", data: "pwd\r" });
    h.emit("message", { data: JSON.stringify({ type: "output", data: "/tmp" }) });
    expect(h.status.at(-1).message).toBe("Connected");
    expect(h.sent.at(-1)).toEqual({ type: "input", data: "pwd\r" });
    expect(h.lines).toContain("/tmp");
    h.connection.stop();
  });

  test("preserves shell failure and exit status across close events", () => {
    for (const payload of [{ type: "error", message: "Shell path does not exist" }, { type: "exit", code: 7 }]) {
      const h = harness();
      h.emit("open");
      h.emit("message", { data: JSON.stringify(payload) });
      h.emit("close", { code: 1011 });
      expect(h.status.at(-1).message).toBe(payload.type === "error" ? payload.message : "Session ended");
      expect(h.status.at(-1).final).toBe(true);
      h.connection.stop();
    }
  });

  test("identifies upgrade and shell phases for early close", () => {
    const upgrade = harness();
    upgrade.emit("close", { code: 1006 });
    expect(upgrade.status.at(-1).message).toContain("WebSocket upgrade failed");
    const shell = harness();
    shell.emit("open");
    shell.emit("close", { code: 1006 });
    expect(shell.status.at(-1).message).toContain("during shell startup");
    upgrade.connection.stop(); shell.connection.stop();
  });

  test("bounds startup and ignores old socket callbacks during reconnect", async () => {
    const timeout = harness(5);
    timeout.emit("open");
    await Bun.sleep(15);
    expect(timeout.status.at(-1).message).toContain("Shell startup timed out");
    const old = harness();
    old.deactivate();
    old.emit("open"); old.emit("error"); old.emit("close", { code: 1006 });
    expect(old.status).toEqual([]);
    expect(old.sent).toEqual([]);
    old.connection.stop(); timeout.connection.stop();
  });

  test("explicit disconnect clears callbacks without reporting failure", () => {
    const h = harness();
    h.connection.stop();
    h.emit("error");
    expect(h.status).toEqual([]);
  });
});
