import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { RequestAuthContext } from "../auth/request-context";
import { TerminalSessionManager } from "../terminal/terminal-session-manager";
import { resolveTerminalConfig } from "../terminal/terminal-config";
import { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import {
  handleTerminalWebSocketUpgrade,
  createTerminalWebSocketHandler,
  type TerminalWebSocketData,
} from "./terminal-websocket";

const adminAuth: RequestAuthContext = {
  npub: "npub1admin",
  actorNpub: "npub1admin",
  signerNpub: "npub1admin",
  subjectNpub: "npub1admin",
  targetOwnerNpub: "npub1admin",
  delegatedOwnerNpub: null,
  delegateRelationshipId: null,
  delegateScopes: null,
  session: {
    npub: "npub1admin",
    nonce: "nonce",
    issuedAt: 0,
    expiresAt: 999999,
  },
  authMethod: "session",
};

describe("terminal websocket upgrade", () => {
  test("ignores non-terminal websocket paths", async () => {
    const response = await handleTerminalWebSocketUpgrade(
      new Request("http://localhost/api/other/ws"),
      new URL("http://localhost/api/other/ws"),
      adminAuth,
      {} as unknown as Server<TerminalWebSocketData>,
      {
        publicOrigin: "http://localhost",
        tickets: new TerminalTicketStore({ ttlMs: 30000 }),
        sessions: new TerminalSessionManager(resolveTerminalConfig({
          env: {},
          defaultCwd: "/tmp/autopilot",
        })),
        pinService: { isConfigured: () => true } as any,
        isAdminNpub: () => true,
      },
    );

    expect(response).toBeNull();
  });

  test("upgrades a valid admin ticket and returns undefined for Bun", async () => {
    const tickets = new TerminalTicketStore({ ttlMs: 30000, now: () => 100 });
    const { ticket } = tickets.create("npub1admin");
    let upgraded = false;
    const server = {
      upgrade(_request: Request, options: { data?: TerminalWebSocketData }) {
        upgraded = options.data?.kind === "terminal" && options.data.npub === "npub1admin";
        return true;
      },
    } as unknown as Server<TerminalWebSocketData>;

    const response = await handleTerminalWebSocketUpgrade(
      new Request(`http://localhost/api/terminal/ws?ticket=${ticket}`, { headers: { origin: "http://localhost" } }),
      new URL(`http://localhost/api/terminal/ws?ticket=${ticket}`),
      adminAuth,
      server,
      {
        publicOrigin: "http://localhost",
        tickets,
        sessions: new TerminalSessionManager(resolveTerminalConfig({
          env: {},
          defaultCwd: "/tmp/autopilot",
        })),
        pinService: { isConfigured: () => true } as any,
        isAdminNpub: (npub) => npub === "npub1admin",
      },
    );

    expect(response).toBeUndefined();
    expect(upgraded).toBe(true);
    expect(tickets.consume(ticket, "npub1admin")).toBe(false);
  });

  test("fails closed before consuming a ticket when no PIN is configured", async () => {
    const tickets = new TerminalTicketStore({ ttlMs: 30000, now: () => 100 });
    const { ticket } = tickets.create("npub1admin");
    const response = await handleTerminalWebSocketUpgrade(
      new Request(`http://localhost/api/terminal/ws?ticket=${ticket}`, { headers: { origin: "http://localhost" } }),
      new URL(`http://localhost/api/terminal/ws?ticket=${ticket}`),
      adminAuth,
      { upgrade: () => true } as unknown as Server<TerminalWebSocketData>,
      {
        publicOrigin: "http://localhost",
        tickets,
        sessions: new TerminalSessionManager(resolveTerminalConfig({ env: {}, defaultCwd: "/tmp/autopilot" })),
        pinService: { isConfigured: () => false } as any,
        isAdminNpub: () => true,
      },
    );
    expect(response?.status).toBe(503);
    expect(tickets.consume(ticket, "npub1admin")).toBe(true);
  });
});

describe("terminal websocket startup lifecycle", () => {
  test("disconnect while start is pending prevents ready and duplicate shell creation", async () => {
    let resolveStart!: () => void;
    let starts = 0;
    let closes = 0;
    const messages: Array<Record<string, unknown>> = [];
    const ctx = {
      sessions: {
        start: () => { starts += 1; return new Promise<void>((resolve) => { resolveStart = resolve; }); },
        close: () => { closes += 1; },
      },
    } as any;
    const ws = {
      data: { kind: "terminal", connectionId: "pending", npub: "npub1admin" },
      sendText: (text: string) => messages.push(JSON.parse(text)),
      close: () => {},
    } as any;
    const handler = createTerminalWebSocketHandler(ctx);
    const pending = handler.message(ws, JSON.stringify({ type: "start" }));
    await handler.message(ws, JSON.stringify({ type: "start" }));
    expect(starts).toBe(1);
    handler.close(ws);
    resolveStart();
    await pending;
    expect(closes).toBe(1);
    expect(messages.some((p) => p.type === "ready")).toBe(false);
  });

  test("upgrade failure burns a valid one-use ticket and records its phase without logging the ticket", async () => {
    const tickets = new TerminalTicketStore({ ttlMs: 30000 });
    const ticket = tickets.create("npub1admin").ticket;
    const failures: string[] = [];
    const request = new Request(`http://localhost/api/terminal/ws?ticket=${ticket}`, { headers: { origin: "http://localhost" } });
    const response = await handleTerminalWebSocketUpgrade(request, new URL(request.url), adminAuth, { upgrade: () => false }, {
      publicOrigin: "http://localhost", tickets, sessions: {} as any, pinService: { isConfigured: () => true } as any,
      isAdminNpub: () => true, reportFailure: (phase, reason) => failures.push(`${phase}: ${reason}`),
    });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "WebSocket upgrade failed", phase: "upgrade" });
    expect(tickets.consume(ticket, "npub1admin")).toBe(false);
    expect(failures).toEqual(["upgrade: WebSocket upgrade failed"]);
    expect(failures.join()).not.toContain(ticket);
  });
});
