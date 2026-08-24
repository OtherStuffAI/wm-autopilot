import { Terminal } from "/vendor/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "/vendor/@xterm/addon-fit/lib/addon-fit.mjs";

let socket = null;
let terminal = null;
let fitAddon = null;
let resizeObserver = null;
let inputDisposable = null;

function cleanupTerminal() {
  inputDisposable?.dispose?.();
  inputDisposable = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  terminal?.dispose?.();
  terminal = null;
  fitAddon = null;
}

function sendJson(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function buildTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--bg-primary").trim() || "#0a0a0a",
    foreground: styles.getPropertyValue("--text-primary").trim() || "#f5f5f5",
    cursor: styles.getPropertyValue("--accent-primary").trim() || "#22c55e",
    selectionBackground: "rgba(125, 211, 252, 0.28)",
  };
}

function openTerminal(container) {
  cleanupTerminal();
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: buildTerminalTheme(),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();
  inputDisposable = terminal.onData((data) => {
    sendJson({ type: "input", data });
  });
  resizeObserver = new ResizeObserver(() => {
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    sendJson({ type: "resize", cols: terminal.cols, rows: terminal.rows });
  });
  resizeObserver.observe(container);
  return terminal;
}

function terminalWsUrl(ticket) {
  const url = new URL("/api/terminal/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export function disconnectTerminalClient() {
  if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
    socket.close();
  }
  socket = null;
  cleanupTerminal();
}

export async function fetchTerminalStatus() {
  const response = await fetch("/api/terminal/status", {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Terminal status unavailable");
  }
  return payload;
}

export async function connectTerminalClient({ pin, container, onStatus }) {
  disconnectTerminalClient();
  onStatus?.("Authenticating terminal access...");
  const authResponse = await fetch("/api/terminal/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ pin }),
  });
  const authPayload = await authResponse.json().catch(() => ({}));
  if (!authResponse.ok) {
    throw new Error(authPayload.error || "Terminal authentication failed");
  }

  const term = openTerminal(container);
  term.writeln("Opening shell...");
  onStatus?.("Connecting...");

  socket = new WebSocket(terminalWsUrl(authPayload.ticket));
  socket.addEventListener("open", () => {
    sendJson({ type: "start", cols: term.cols, rows: term.rows });
  });
  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "ready") {
      onStatus?.("Connected");
      term.focus();
    } else if (payload.type === "output") {
      term.write(payload.data || "");
    } else if (payload.type === "exit") {
      term.writeln("");
      term.writeln(`[process exited${typeof payload.code === "number" ? `: ${payload.code}` : ""}]`);
      onStatus?.("Session ended");
    } else if (payload.type === "error") {
      term.writeln("");
      term.writeln(`[terminal error] ${payload.message || "Unknown error"}`);
      onStatus?.(payload.message || "Terminal error");
    }
  });
  socket.addEventListener("close", () => {
    onStatus?.("Disconnected");
  });
  socket.addEventListener("error", () => {
    onStatus?.("Connection error");
  });
}
