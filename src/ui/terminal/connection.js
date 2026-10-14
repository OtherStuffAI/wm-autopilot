const START_TIMEOUT_MS = 15_000;

/** Transient socket lifecycle; callbacks belong to this connection only. */
export function bindTerminalConnection({ socket, terminal, onStatus, isCurrent, timeoutMs = START_TIMEOUT_MS }) {
  let phase = "upgrade";
  let finalMessage = null;
  let stopped = false;
  const current = () => !stopped && isCurrent();
  const report = (message, state = "info", final = false) => {
    if (!current()) return;
    if (final) finalMessage = message;
    onStatus?.(message, { state, final });
  };
  const fail = (message) => {
    if (!current() || finalMessage) return;
    clearTimeout(timer);
    terminal.writeln("");
    terminal.writeln(`[terminal error] ${message}`);
    report(message, "error", true);
  };
  const timer = setTimeout(() => {
    fail(phase === "upgrade"
      ? "WebSocket connection timed out. Check sign-in, the public origin and proxy WebSocket support; reconnect for a fresh ticket."
      : "Shell startup timed out. Check the server terminal log and TMAN_NODE_BIN, TMAN_SHELL and TMAN_CWD.");
    socket.close();
  }, timeoutMs);
  const send = (payload) => {
    if (current() && socket.readyState === 1) socket.send(JSON.stringify(payload));
  };

  socket.addEventListener("open", () => {
    if (!current()) { socket.close(); return; }
    phase = "shell";
    terminal.writeln("Opening shell...");
    report("Starting shell...");
    send({ type: "start", cols: terminal.cols, rows: terminal.rows });
  });
  socket.addEventListener("message", (event) => {
    if (!current() || finalMessage) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { fail("Invalid terminal server message"); socket.close(); return; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) { fail("Invalid terminal server message"); socket.close(); return; }
    if (payload.type === "ready") {
      clearTimeout(timer);
      phase = "connected";
      report("Connected", "ready");
      terminal.focus();
    } else if (payload.type === "output") {
      terminal.write(payload.data || "");
    } else if (payload.type === "exit") {
      clearTimeout(timer);
      terminal.writeln("");
      terminal.writeln(`[process exited${typeof payload.code === "number" ? `: ${payload.code}` : ""}]`);
      report("Session ended", "info", true);
      socket.close();
    } else if (payload.type === "error") {
      fail(payload.message || "Terminal shell startup failed. Check the server terminal log.");
      socket.close();
    }
  });
  socket.addEventListener("close", (event) => {
    clearTimeout(timer);
    if (!current() || finalMessage) return;
    const details = ` (code ${event.code})`;
    fail(phase === "upgrade"
      ? `WebSocket upgrade failed${details}. Check sign-in, origin and ticket rejection in the server terminal log; reconnect for a fresh ticket.`
      : phase === "shell"
        ? `Connection closed during shell startup${details}. Check the server terminal log and PTY helper configuration.`
        : `Terminal connection lost${details}. Reconnect to start a new shell.`);
  });
  socket.addEventListener("error", () => {
    fail(phase === "upgrade"
      ? "WebSocket connection failed. Check sign-in, the public origin and proxy WebSocket support; reconnect for a fresh ticket."
      : "Terminal transport failed. Check the server terminal log and reconnect.");
    socket.close();
  });

  return {
    send(payload) { if (phase === "connected" && !finalMessage) send(payload); },
    stop() { stopped = true; clearTimeout(timer); socket.close(); },
  };
}
