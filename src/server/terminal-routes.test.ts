import { describe, expect, test } from "bun:test";
import { AccessActions } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import { TerminalPinRateLimiter } from "../terminal/terminal-pin-rate-limiter";
import { handleTerminalApi, type TerminalRoutesContext } from "./terminal-routes";

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

function createContext(overrides: Partial<TerminalRoutesContext> = {}): TerminalRoutesContext {
  let configured = true;
  let currentPin = "12345";
  return {
    config: {
      shell: "/bin/bash",
      cwd: "/tmp/autopilot",
      ptyMode: "bridge",
      ticketTtlMs: 30000,
    },
    tickets: new TerminalTicketStore({ ttlMs: 30000, now: () => 100 }),
    sessions: {
      checkAvailability: async () => ({ available: true, error: null }),
    } as TerminalRoutesContext["sessions"],
    pinService: {
      isConfigured: () => configured,
      verify: (pin: string) => configured && pin === currentPin,
      setPin: (pin: string) => {
        configured = true;
        currentPin = pin;
      },
    } as unknown as TerminalRoutesContext["pinService"],
    rateLimiter: new TerminalPinRateLimiter({ now: () => 100, threshold: 2, baseDelayMs: 1000 }),
    ensureApiAccess: async () => null,
    AccessActions: { TerminalAccess: AccessActions.TerminalAccess },
    ...overrides,
  };
}

describe("terminal routes", () => {
  test("GET /api/terminal/status returns PTY availability", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/status"),
      new URL("http://localhost/api/terminal/status"),
      "GET",
      adminAuth,
      createContext(),
    );

    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      available: true,
      configured: true,
      pinRequired: true,
      cwd: "/tmp/autopilot",
      shell: "/bin/bash",
    });
  });

  test("POST /api/terminal/auth rejects wrong PIN", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", {
        method: "POST",
        body: JSON.stringify({ pin: "54321" }),
      }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      createContext(),
    );

    expect(response?.status).toBe(403);
  });

  test("POST /api/terminal/auth returns a consumable ticket for the admin", async () => {
    const ctx = createContext();
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", {
        method: "POST",
        body: JSON.stringify({ pin: "12345" }),
      }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      ctx,
    );

    expect(response?.status).toBe(200);
    const payload = await response!.json() as { ticket: string };
    expect(typeof payload.ticket).toBe("string");
    expect(ctx.tickets.consume(payload.ticket, "npub1admin")).toBe(true);
  });

  test("fails closed when no PIN is configured", async () => {
    const ctx = createContext({
      pinService: { isConfigured: () => false, verify: () => false } as unknown as TerminalRoutesContext["pinService"],
    });
    const status = await handleTerminalApi(
      new Request("http://localhost/api/terminal/status"),
      new URL("http://localhost/api/terminal/status"),
      "GET",
      adminAuth,
      ctx,
    );
    const auth = await handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", { method: "POST", body: JSON.stringify({ pin: "44444" }) }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      ctx,
    );
    expect(status?.status).toBe(503);
    expect(auth?.status).toBe(503);
  });

  test("replaces the PIN and revokes outstanding tickets", async () => {
    const ctx = createContext();
    const existing = ctx.tickets.create("npub1admin");
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/pin", {
        method: "PUT",
        body: JSON.stringify({ pin: "67890", confirmPin: "67890" }),
      }),
      new URL("http://localhost/api/terminal/pin"),
      "PUT",
      adminAuth,
      ctx,
    );
    expect(response?.status).toBe(200);
    expect(ctx.tickets.consume(existing.ticket, "npub1admin")).toBe(false);
    expect(ctx.pinService.verify("12345")).toBe(false);
    expect(ctx.pinService.verify("67890")).toBe(true);
  });

  test("rate limits repeated wrong PIN attempts", async () => {
    const ctx = createContext();
    const attempt = () => handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", { method: "POST", body: JSON.stringify({ pin: "54321" }) }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      ctx,
    );
    expect((await attempt())?.status).toBe(403);
    expect((await attempt())?.status).toBe(403);
    const blocked = await attempt();
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe("1");
  });

  test("returns access denial from access policy", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/status"),
      new URL("http://localhost/api/terminal/status"),
      "GET",
      adminAuth,
      createContext({
        ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      }),
    );

    expect(response?.status).toBe(403);
  });

  test("denies a non-admin even when the PIN is correct", async () => {
    const response = await handleTerminalApi(
      new Request("http://localhost/api/terminal/auth", {
        method: "POST",
        body: JSON.stringify({ pin: "12345" }),
      }),
      new URL("http://localhost/api/terminal/auth"),
      "POST",
      adminAuth,
      createContext({
        ensureApiAccess: async () => Response.json({ error: "admin-only" }, { status: 403 }),
      }),
    );
    expect(response?.status).toBe(403);
  });
});
