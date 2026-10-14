import { Terminal } from "/vendor/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "/vendor/@xterm/addon-fit/lib/addon-fit.mjs";

import { bindTerminalConnection } from "./connection.js";

let connection = null;
let attempt = 0;
let authController = null;
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
  connection?.send(payload);
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
  attempt += 1;
  authController?.abort();
  authController = null;
  connection?.stop();
  connection = null;
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
  const currentAttempt = attempt;
  onStatus?.("Authenticating terminal access...");
  const controller = new AbortController();
  authController = controller;
  const authTimeout = setTimeout(() => controller.abort(), 15_000);
  let authResponse;
  let authPayload;
  try {
    authResponse = await fetch("/api/terminal/auth", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ pin }),
    });
    authPayload = await authResponse.json().catch(() => ({}));
  } catch {
    if (currentAttempt !== attempt) return;
    throw new Error("Terminal PIN/ticket request failed or timed out. Check sign-in and server availability, then reconnect.");
  } finally {
    clearTimeout(authTimeout);
    if (authController === controller) authController = null;
  }
  if (currentAttempt !== attempt) return;
  if (!authResponse.ok) {
    throw new Error(`Terminal PIN/ticket authentication failed: ${authPayload.message || authPayload.error || "Check sign-in and PIN"}`);
  }

  if (typeof authPayload.ticket !== "string" || !authPayload.ticket) {
    throw new Error("Terminal authentication returned no ticket. Check the server terminal configuration.");
  }
  const term = openTerminal(container);
  term.writeln("Opening terminal connection...");
  onStatus?.("Connecting WebSocket...");

  const socket = new WebSocket(terminalWsUrl(authPayload.ticket));
  connection = bindTerminalConnection({ socket, terminal: term, onStatus, isCurrent: () => currentAttempt === attempt });
}
