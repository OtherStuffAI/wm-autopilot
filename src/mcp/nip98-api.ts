/**
 * NIP-98 API Handler
 *
 * HTTP handler for /api/mcp/nip98/* routes.
 * Called by the MCP stdio server (running inside agent processes)
 * to sign NIP-98 tokens and manage grants, and by browsers to
 * subscribe to signing requests and post signed events back.
 *
 * Follows the CaproverApi pattern — factory function returning a
 * (request, url, method) => Response handler.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import { readSessionCookie } from "../auth/session-cookie";
import { signWithWingmanKey, isWingmanKeyAvailable } from "./wingman-signer";
import { pendingSignRequests } from "./pending-requests";
import { browserSubscribers } from "./browser-subscribers";
import type { Nip98GrantStore } from "./grants-store";
import type { SignRequestMessage } from "./types";
import { parseBody, jsonError } from "../utils/request-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NIP98_KIND = 27235;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface Nip98ApiDependencies {
  grantsStore: Nip98GrantStore;
  /** Resolve a session by its ID. Returns null if not found. */
  getSession: (sessionId: string) => SessionSnapshot | null;
  /** Called when a browser subscribes to SSE — used to trigger bot key unlock. */
  onBrowserSubscribe?: (npub: string) => void;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract npub from session cookie on a browser request. */
function getNpubFromCookie(request: Request): string | null {
  try {
    const cookieHeader = request.headers.get("cookie");
    const session = readSessionCookie(cookieHeader);
    return session?.npub ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createNip98ApiHandler(deps: Nip98ApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/mcp/nip98")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "mcp", "nip98", ...]

    try {
      // POST /api/mcp/nip98/sign
      if (segments.length === 4 && segments[3] === "sign" && method === "POST") {
        return await handleSign(deps, request);
      }

      // POST /api/mcp/nip98/request-grant
      if (segments.length === 4 && segments[3] === "request-grant" && method === "POST") {
        return await handleRequestGrant(deps, request);
      }

      // GET /api/mcp/nip98/grants?sessionId=...
      if (segments.length === 4 && segments[3] === "grants" && method === "GET") {
        return handleListGrants(deps, url);
      }

      // DELETE /api/mcp/nip98/grants/:id
      if (segments.length === 5 && segments[3] === "grants" && method === "DELETE") {
        return handleRevokeGrant(deps, segments[4]!);
      }

      // GET /api/mcp/nip98/status
      if (segments.length === 4 && segments[3] === "status" && method === "GET") {
        return handleStatus();
      }

      // GET /api/mcp/nip98/subscribe — browser SSE for signing requests
      if (segments.length === 4 && segments[3] === "subscribe" && method === "GET") {
        return handleSubscribe(request, deps);
      }

      // POST /api/mcp/nip98/sign-response — browser posts signed events
      if (segments.length === 4 && segments[3] === "sign-response" && method === "POST") {
        return await handleSignResponse(request);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[nip98-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/mcp/nip98/sign
 *
 * Body: { sessionId, url, method, bodyHash?, tier? }
 * Returns: { token, signedBy }
 */
async function handleSign(
  deps: Nip98ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const targetUrl = body.url as string | undefined;
  const httpMethod = body.method as string | undefined;
  const bodyHash = body.bodyHash as string | undefined;
  const tier = (body.tier as number) ?? 1;

  if (!sessionId || !targetUrl || !httpMethod) {
    return jsonError("sessionId, url, and method are required", 400);
  }

  // Validate the session exists
  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  if (tier === 1) {
    return jsonError("Tier 1 session-UUID signing is retired; use the scoped capability broker", 410);
  }

  if (tier === 2) {
    return await handleTier2Sign(deps, session, sessionId, targetUrl, httpMethod, bodyHash);
  }

  return jsonError("tier must be 1 or 2", 400);
}

/**
 * Tier 2 signing — route the request to the user's browser via SSE.
 */
async function handleTier2Sign(
  deps: Nip98ApiDependencies,
  session: SessionSnapshot,
  sessionId: string,
  targetUrl: string,
  httpMethod: string,
  bodyHash?: string,
): Promise<Response> {
  if (!session.npub) {
    return jsonError("Session has no associated user — cannot sign Tier 2", 403);
  }

  const domain = new URL(targetUrl).hostname;
  const grant = deps.grantsStore.findActiveGrant(domain, session.npub, sessionId);
  if (!grant) {
    return jsonError(
      `No active grant for ${domain}. Call request_api_access first.`,
      403,
    );
  }

  // Check that at least one browser is listening
  if (!browserSubscribers.hasSubscriber(session.npub)) {
    return jsonError(
      "No active browser session for this user. Open the Wingman UI in a browser to enable Tier 2 signing.",
      503,
    );
  }

  // Build the NIP-98 event template (unsigned)
  const tags: string[][] = [
    ["u", targetUrl],
    ["method", httpMethod.toUpperCase()],
  ];
  if (bodyHash) {
    tags.push(["payload", bodyHash]);
  }

  const eventTemplate: SignRequestMessage["eventTemplate"] = {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };

  // Create a pending request and send to browser
  const { requestId, promise } = pendingSignRequests.create(session.npub);

  const signRequest: SignRequestMessage = {
    type: "nip98:sign_request",
    requestId,
    grantId: grant.id,
    eventTemplate,
  };

  const delivered = browserSubscribers.send(
    session.npub,
    signRequest as unknown as Record<string, unknown>,
  );
  if (!delivered) {
    pendingSignRequests.reject(requestId, "Failed to deliver signing request to browser");
    return jsonError("Browser subscriber disconnected before delivery", 503);
  }

  console.log(
    `[nip98-api] Tier 2 sign request ${requestId} sent to browser for ${domain} (npub=${session.npub.slice(0, 20)}…)`,
  );

  // Wait for browser to sign and post back
  try {
    const signedEvent = await promise;

    // Build the Authorization header value
    const eventJson = JSON.stringify(signedEvent);
    const base64Token = btoa(eventJson);
    const token = `Nostr ${base64Token}`;

    // Extract signedBy from the event's pubkey
    const signedBy = typeof signedEvent.pubkey === "string" ? signedEvent.pubkey : session.npub;

    return Response.json({ token, signedBy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Browser signing failed";
    console.warn(`[nip98-api] Tier 2 sign failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/mcp/nip98/request-grant
 *
 * Body: { sessionId, domain, reason, durationHours?, endpoints? }
 * Returns: { granted, grantId? } or { error }
 */
async function handleRequestGrant(
  deps: Nip98ApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;
  const domain = body.domain as string | undefined;
  const reason = body.reason as string | undefined;
  const durationHours = (body.durationHours as number) ?? 24;
  const endpoints = body.endpoints as Array<{ method: string; path: string }> | undefined;

  if (!sessionId || !domain || !reason) {
    return jsonError("sessionId, domain, and reason are required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return jsonError("Session has no associated user", 403);
  }

  // Auto-approve grants (consent UI deferred to a later phase)
  const grant = deps.grantsStore.createGrant({
    domain,
    userNpub: session.npub,
    sessionId,
    signerType: "nip07",
    durationHours: Math.min(durationHours, 168), // Cap at 7 days
    reason,
    endpoints: endpoints?.map((e) => ({
      method: e.method as "GET" | "POST" | "PUT" | "DELETE" | "*",
      pathPattern: e.path,
    })),
  });

  console.log(
    `[nip98-api] Grant auto-approved: ${grant.id} for ${domain} (session=${sessionId})`,
  );

  return Response.json({ granted: true, grantId: grant.id });
}

/**
 * GET /api/mcp/nip98/grants?sessionId=...
 */
function handleListGrants(deps: Nip98ApiDependencies, url: URL): Response {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return jsonError("sessionId query parameter is required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  if (!session.npub) {
    return Response.json({ grants: [] });
  }

  const grants = deps.grantsStore.listGrantsForSession(sessionId, session.npub);
  return Response.json({ grants });
}

/**
 * DELETE /api/mcp/nip98/grants/:id
 */
function handleRevokeGrant(deps: Nip98ApiDependencies, grantId: string): Response {
  const removed = deps.grantsStore.revokeGrant(grantId);
  if (!removed) {
    return jsonError("Grant not found", 404);
  }
  return Response.json({ success: true });
}

/**
 * GET /api/mcp/nip98/status
 */
function handleStatus(): Response {
  return Response.json({
    tier1Available: isWingmanKeyAvailable(),
    tier2Available: true,
  });
}

/**
 * GET /api/mcp/nip98/subscribe
 *
 * Browser SSE endpoint. The browser subscribes after login to receive
 * NIP-98 signing requests. Validated via session cookie.
 */
function handleSubscribe(request: Request, deps: Nip98ApiDependencies): Response {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const encoder = new TextEncoder();
  let subscriberController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  return new Response(
    new ReadableStream({
      start(controller) {
        subscriberController = controller;
        browserSubscribers.add(npub, controller);

        // Send initial connected event
        controller.enqueue(encoder.encode(": connected\n\n"));

        // Notify callback so server can trigger pending bot key unlock
        if (deps.onBrowserSubscribe) {
          try { deps.onBrowserSubscribe(npub); } catch { /* non-fatal */ }
        }

        // Keepalive to prevent proxy/browser idle timeout
        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          }
        }, SSE_KEEPALIVE_INTERVAL_MS);
      },
      cancel() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (subscriberController) {
          browserSubscribers.remove(npub, subscriberController);
          subscriberController = null;
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    },
  );
}

/**
 * POST /api/mcp/nip98/sign-response
 *
 * Browser posts signed NIP-98 events back here to resolve pending requests.
 * Body: { requestId, signedEvent? , error? }
 * Validated via session cookie.
 */
async function handleSignResponse(request: Request): Promise<Response> {
  const npub = getNpubFromCookie(request);
  if (!npub) {
    return jsonError("Not authenticated — session cookie required", 401);
  }

  const body = await parseBody(request);
  const requestId = body.requestId as string | undefined;
  if (!requestId) {
    return jsonError("requestId is required", 400);
  }

  const signedEvent = body.signedEvent as Record<string, unknown> | undefined;
  const error = body.error as string | undefined;

  if (error) {
    const rejected = pendingSignRequests.reject(requestId, error);
    if (!rejected) {
      return jsonError("No pending request found for this requestId (may have timed out)", 404);
    }
    return Response.json({ ok: true, resolved: false });
  }

  if (!signedEvent) {
    return jsonError("Either signedEvent or error is required", 400);
  }

  const resolved = pendingSignRequests.resolve(requestId, signedEvent);
  if (!resolved) {
    return jsonError("No pending request found for this requestId (may have timed out)", 404);
  }

  console.log(`[nip98-api] Sign response received for request ${requestId}`);
  return Response.json({ ok: true, resolved: true });
}
