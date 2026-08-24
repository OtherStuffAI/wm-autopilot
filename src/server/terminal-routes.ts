import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import type { TerminalConfig } from "../terminal/terminal-config";
import type { TerminalSessionManager } from "../terminal/terminal-session-manager";
import type { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import type { TerminalPinService } from "../terminal/terminal-pin-service";
import type { TerminalPinRateLimiter } from "../terminal/terminal-pin-rate-limiter";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface TerminalRoutesContext {
  config: TerminalConfig;
  tickets: TerminalTicketStore;
  sessions: TerminalSessionManager;
  pinService: TerminalPinService;
  rateLimiter: TerminalPinRateLimiter;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { TerminalAccess: AccessAction };
}

export async function handleTerminalApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: TerminalRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/terminal/")) {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.TerminalAccess, request, url, authContext);
  if (denied) return denied;

  const npub = getEffectiveOwnerNpub(authContext);
  if (!npub) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  if (url.pathname === "/api/terminal/pin" && method === "PUT") {
    const payload = await readJsonRecord(request);
    if (payload instanceof Response) return payload;
    const pin = typeof payload.pin === "string" ? payload.pin : "";
    const confirmation = typeof payload.confirmPin === "string" ? payload.confirmPin : "";
    if (pin !== confirmation) {
      return Response.json({ error: "PIN confirmation does not match" }, { status: 400 });
    }
    try {
      ctx.pinService.setPin(pin);
      ctx.rateLimiter.clear();
      ctx.tickets.clear();
      return Response.json({ success: true, configured: true });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid PIN" }, { status: 400 });
    }
  }

  if (!ctx.pinService.isConfigured()) {
    return Response.json({ error: "Terminal is not configured", configured: false }, { status: 503 });
  }

  if (url.pathname === "/api/terminal/status" && method === "GET") {
    const availability = await ctx.sessions.checkAvailability();
    return Response.json({
      available: availability.available,
      error: availability.error,
      configured: true,
      pinRequired: true,
      cwd: ctx.config.cwd,
      shell: ctx.config.shell,
    });
  }

  if (url.pathname === "/api/terminal/auth" && method === "POST") {
    const retryAfterMs = ctx.rateLimiter.retryAfterMs(npub);
    if (retryAfterMs > 0) {
      return terminalAuthFailure(429, retryAfterMs);
    }
    const payload = await readJsonRecord(request);
    if (payload instanceof Response) return payload;
    const pin = typeof payload.pin === "string" ? payload.pin : "";
    if (!ctx.pinService.verify(pin)) {
      return terminalAuthFailure(403, ctx.rateLimiter.recordFailure(npub));
    }
    ctx.rateLimiter.clear(npub);
    const ticket = ctx.tickets.create(npub);
    return Response.json(ticket);
  }

  return null;
}

function terminalAuthFailure(status: 403 | 429, retryAfterMs: number): Response {
  const headers = new Headers();
  if (retryAfterMs > 0) headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return Response.json(
    { error: "Terminal authentication failed", ...(retryAfterMs > 0 ? { retryAfterMs } : {}) },
    { status, headers },
  );
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    return payload as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
}
