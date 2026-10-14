import { afterEach, describe, expect, test } from "bun:test";
import { nip19 } from "nostr-tools";
import { AccessActions } from "../auth/access-control";
import { mintSessionCookie } from "../auth/session-cookie";
import { resolveRequestAuthContext } from "../auth/request-context";
import { TerminalPinService } from "../terminal/terminal-pin-service";
import { TerminalPinRateLimiter } from "../terminal/terminal-pin-rate-limiter";
import { TerminalSessionManager } from "../terminal/terminal-session-manager";
import { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import { handleTerminalApi } from "./terminal-routes";
import { handleTerminalWebSocketUpgrade, type TerminalWebSocketData } from "./terminal-websocket";
import { createWingmanWebSocketHandler } from "./websocket-handler";

if (!Bun.env.IDENTITY_SESSION_SECRET) Bun.env.IDENTITY_SESSION_SECRET = "SyntheticTerminal_Secret123!NeverProduction";
const admin = nip19.npubEncode("11".repeat(32));
const other = nip19.npubEncode("22".repeat(32));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(shell = "/bin/sh") {
  let verifier: string | null = null;
  const pinService = new TerminalPinService({
    get: () => verifier,
    set: ({ value }: { value: string }) => { verifier = value; },
  } as any);
  pinService.setPin("12345");
  const config = { shell, cwd: "/tmp", ptyMode: "bridge" as const, ticketTtlMs: 30000 };
  const sessions = new TerminalSessionManager(config);
  let now = Date.now();
  const tickets = new TerminalTicketStore({ ttlMs: 30000, now: () => now });
  const connections = new Set<string>();
  const failures: Array<{ phase: string; reason: string }> = [];
  const ctx = { publicOrigin: "", tickets, sessions, pinService, isAdminNpub: (npub: string | null | undefined) => npub === admin,
    reportFailure: (phase: string, reason: string) => failures.push({ phase, reason }) };
  const server = Bun.serve<TerminalWebSocketData>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const auth = resolveRequestAuthContext(request);
      const upgrade = await handleTerminalWebSocketUpgrade(request, url, auth, {
        upgrade: (req, options) => { connections.add(options.data.connectionId); return server.upgrade(req, options); },
      }, ctx);
      if (upgrade !== null) return upgrade;
      return await handleTerminalApi(request, url, request.method as any, auth, {
        config, tickets, sessions, pinService, rateLimiter: new TerminalPinRateLimiter(), AccessActions,
        ensureApiAccess: async () => !auth.session ? Response.json({ error: "Authentication required" }, { status: 401 })
          : auth.npub !== admin ? Response.json({ error: "admin-only" }, { status: 403 }) : null,
      }) ?? new Response("Not found", { status: 404 });
    },
    websocket: createWingmanWebSocketHandler(ctx),
  });
  ctx.publicOrigin = server.url.origin;
  cleanup.push(() => { for (const id of connections) sessions.close(id); server.stop(true); });
  const cookie = (npub = admin) => mintSessionCookie(npub, { secure: false }).cookie.split(";")[0]!;
  const headers = () => ({ cookie: cookie(), origin: ctx.publicOrigin });
  const auth = async () => {
    const response = await fetch(new URL("/api/terminal/auth", server.url), { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ pin: "12345" }) });
    expect(response.status).toBe(200);
    return (await response.json()).ticket as string;
  };
  return { server, sessions, tickets, cookie, headers, auth, failures, expire: () => { now += 30001; } };
}

function socketProbe(f: ReturnType<typeof fixture>, ticket: string) {
  const ws = new WebSocket(`${f.server.url.origin.replace("http:", "ws:")}/api/terminal/ws?ticket=${ticket}`, { headers: f.headers() });
  const messages: Array<Record<string, any>> = [];
  cleanup.push(() => ws.close());
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "start", cols: 90, rows: 30 })));
  return { ws, messages };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

describe("authenticated isolated terminal", () => {
  test("uses a real session cookie, PIN, ticket, WebSocket and native PTY for start/output/input/disconnect", async () => {
    const f = fixture();
    const ticket = await f.auth();
    const { ws, messages } = socketProbe(f, ticket);
    await waitFor(() => messages.some((p) => p.type === "ready"));
    // Disable echo so success is shell execution, not merely echoed input.
    ws.send(JSON.stringify({ type: "input", data: "stty -echo\rprintf 'NATIVE_%s_OK:%s\\n' TERMINAL $$\r" }));
    await waitFor(() => messages.some((p) => p.type === "output" && p.data.includes("NATIVE_TERMINAL_OK")));
    const output = messages.filter((p) => p.type === "output").map((p) => p.data).join("");
    const shellPid = Number(output.match(/NATIVE_TERMINAL_OK:(\d+)/)?.[1]);
    expect(shellPid).toBeGreaterThan(0);
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
    ws.close();
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    await waitFor(() => {
      try { process.kill(shellPid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    });
    expect(f.tickets.consume(ticket, admin)).toBe(false);
    expect(f.failures).toEqual([]);
  });

  test("reports actual missing shell failure without ready, then closes", async () => {
    const f = fixture("/nonexistent/wingman-synthetic-shell");
    const { ws, messages } = socketProbe(f, await f.auth());
    await waitFor(() => messages.some((p) => p.type === "error"));
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect(messages.some((p) => p.type === "ready")).toBe(false);
    expect(messages.find((p) => p.type === "error")?.phase).toBe("shell");
    expect(f.failures.some((p) => p.phase === "shell")).toBe(true);
  });

  test("rejects missing/non-admin sessions, invalid/expired/reused/wrong-owner tickets and exact-origin violations", async () => {
    const f = fixture();
    const request = (ticket: string, headers: Record<string, string>) => fetch(new URL(`/api/terminal/ws?ticket=${ticket}`, f.server.url), { headers });
    const ticket = await f.auth();
    expect((await request(ticket, { origin: f.server.url.origin })).status).toBe(401);
    expect((await request(ticket, { ...f.headers(), cookie: f.cookie(other) })).status).toBe(401);
    expect((await request(ticket, { ...f.headers(), cookie: "wingman_identity_session=invalid" })).status).toBe(401);
    for (const origin of ["null", "https://attacker.example", f.server.url.origin + "/", ""]) {
      expect((await request(ticket, { ...f.headers(), origin, "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" })).status).toBe(403);
    }
    expect((await request(ticket, { cookie: f.cookie() })).status).toBe(403);
    expect(f.tickets.consume(ticket, admin)).toBe(true); // Origin/auth refusal did not burn the ticket.
    expect((await request(ticket, f.headers())).status).toBe(403);
    expect((await request("invalid", f.headers())).status).toBe(403);
    const wrongOwner = f.tickets.create(other).ticket;
    expect((await request(wrongOwner, f.headers())).status).toBe(403);
    const expired = await f.auth(); f.expire();
    expect((await request(expired, f.headers())).status).toBe(403);
    const spoof = { ...f.headers(), cookie: "", "x-owner-npub": admin, authorization: "Nostr invalid" };
    expect((await request("invalid", spoof)).status).toBe(401);
  });
});

test("native shell exit emits a single exit frame", async () => {
  const f = fixture();
  const { ws, messages } = socketProbe(f, await f.auth());
  await waitFor(() => messages.some((p) => p.type === "ready"));
  ws.send(JSON.stringify({ type: "input", data: "exit 7\r" }));
  await waitFor(() => messages.some((p) => p.type === "exit"));
  await Bun.sleep(30);
  expect(messages.filter((p) => p.type === "exit")).toHaveLength(1);
  expect(messages.find((p) => p.type === "exit")?.code).toBe(7);
});


test("rejects actual WebSocket handshakes with invalid tickets or origins", async () => {
  const f = fixture();
  async function rejectedHandshake(ticket: string, origin: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${f.server.url.origin.replace("http:", "ws:")}/api/terminal/ws?ticket=${ticket}`, {
        headers: { cookie: f.cookie(), origin },
      });
      cleanup.push(() => ws.close());
      const timer = setTimeout(() => { ws.close(); reject(new Error("Handshake rejection timed out")); }, 2000);
      ws.addEventListener("open", () => { clearTimeout(timer); ws.close(); reject(new Error("Invalid handshake was accepted")); });
      ws.addEventListener("error", () => { clearTimeout(timer); resolve(); });
    });
  }
  await rejectedHandshake("invalid", f.server.url.origin);
  expect(f.failures.at(-1)).toEqual({ phase: "upgrade", reason: "Invalid terminal ticket" });
  const ticket = await f.auth();
  await rejectedHandshake(ticket, "https://attacker.example");
  expect(f.failures.at(-1)).toEqual({ phase: "upgrade", reason: "Terminal origin rejected" });
  expect(f.tickets.consume(ticket, admin)).toBe(true);
});
