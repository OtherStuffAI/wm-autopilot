import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { RequestAuthContext } from "../auth/request-context";
import { TerminalSessionManager } from "../terminal/terminal-session-manager";
import { resolveTerminalConfig } from "../terminal/terminal-config";
import { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import {
  handleTerminalWebSocketUpgrade,
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
      new Request(`http://localhost/api/terminal/ws?ticket=${ticket}`),
      new URL(`http://localhost/api/terminal/ws?ticket=${ticket}`),
      adminAuth,
      server,
      {
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
      new Request(`http://localhost/api/terminal/ws?ticket=${ticket}`),
      new URL(`http://localhost/api/terminal/ws?ticket=${ticket}`),
      adminAuth,
      { upgrade: () => true } as unknown as Server<TerminalWebSocketData>,
      {
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
