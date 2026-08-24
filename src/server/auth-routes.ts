/**
 * API route handlers for authentication endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { normaliseNpub } from "../identity/npub-utils";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { MintSessionCookieOptions, SessionCookiePayload } from "../auth/session-cookie";
import { nip19, verifyEvent } from "nostr-tools";
import { configuredPublicRequestUrl, forwardedRequestUrl } from "./request-url";
import type { LoginChallengeStore } from "../auth/login-challenge-store";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
const LOGIN_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isConfiguredAdminNpub(ctx: AuthApiContext, npub: string | null | undefined): boolean {
  if (ctx.isAdminNpub) {
    return ctx.isAdminNpub(npub);
  }
  const normalized = normaliseNpub(npub);
  return Boolean(ctx.adminNpub && normalized && ctx.adminNpub === normalized);
}

function normalizePathname(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  return normalized || "/";
}

function signedLoginEventNpub(
  input: unknown,
  challenge: string,
  request: Request,
  url: URL,
  ctx: AuthApiContext,
): string {
  if (!input || typeof input !== "object") {
    throw new Error("signedEvent must be an object");
  }

  const event = input as {
    kind?: unknown;
    created_at?: unknown;
    tags?: unknown;
    content?: unknown;
    pubkey?: unknown;
    id?: unknown;
    sig?: unknown;
  };

  if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
    throw new Error("signedEvent signature verification failed");
  }
  if (event.kind !== 27235) {
    throw new Error("signedEvent must be a NIP-98 event");
  }
  if (typeof event.pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(event.pubkey)) {
    throw new Error("signedEvent.pubkey must be a 64 character hex key");
  }
  if (!Number.isInteger(event.created_at)) {
    throw new Error("signedEvent.created_at must be an integer");
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(event.created_at)) > 300) {
    throw new Error("signedEvent is too old");
  }

  const tags = Array.isArray(event.tags) ? event.tags : [];
  const uTag = tags.find((tag): tag is string[] => Array.isArray(tag) && tag[0] === "u" && typeof tag[1] === "string");
  const methodTag = tags.find((tag): tag is string[] => Array.isArray(tag) && tag[0] === "method" && typeof tag[1] === "string");
  const purposeTag = tags.find((tag): tag is string[] => Array.isArray(tag) && tag[0] === "purpose" && typeof tag[1] === "string");
  const challengeTags = tags.filter(
    (tag): tag is string[] => Array.isArray(tag) && tag[0] === "challenge" && typeof tag[1] === "string",
  );

  if (!uTag?.[1]) {
    throw new Error("signedEvent missing u tag");
  }
  if (methodTag?.[1] !== request.method) {
    throw new Error("signedEvent method tag does not match request");
  }
  if (purposeTag?.[1] !== "wingman-login") {
    throw new Error("signedEvent purpose tag must be wingman-login");
  }
  if (challengeTags.length !== 1 || challengeTags[0]?.[1] !== challenge) {
    throw new Error("signedEvent challenge tag does not match login challenge");
  }
  if (event.content !== challenge) {
    throw new Error("signedEvent content does not match login challenge");
  }

  let eventUrl: URL;
  try {
    eventUrl = new URL(uTag[1]);
  } catch {
    throw new Error("signedEvent u tag is not a valid URL");
  }

  const candidates = [
    url,
    forwardedRequestUrl(request, url),
    ctx.config.baseUrl ? configuredPublicRequestUrl(url, ctx.config.baseUrl) : null,
  ].filter((candidate): candidate is URL => Boolean(candidate));

  const matchesUrl = candidates.some(
    (candidate) =>
      eventUrl.origin === candidate.origin &&
      normalizePathname(eventUrl.pathname) === normalizePathname(candidate.pathname),
  );

  if (!matchesUrl) {
    throw new Error("signedEvent u tag does not match login URL");
  }

  return nip19.npubEncode(event.pubkey);
}

// ---------- Context supplied by server.ts ----------

export interface AuthApiContext {
  config: {
    baseUrl?: string;
    registrationEnabled: boolean;
    connectRelays: string[];
    giteaUrl: string | null;
    giteaApiToken: string | null;
    giteaOwner: string | null;
  };
  adminNpub: string | null;
  isAdminNpub?: (npub: string | null | undefined) => boolean;

  identityUserStore: {
    getByNormalized: (npub: string) => { npub: string; pictureUrl: string | null } | null;
    touch: (npub: string, opts: { alias: string; lastSeenAt: string }) => void;
  };

  mintSessionCookie: (npub: string, options?: MintSessionCookieOptions) => {
    cookie: string;
    expiresAt: number;
    payload: SessionCookiePayload;
  };
  getSessionCookieName: (secure: boolean) => string;
  SessionCookieError: new (...args: any[]) => Error;
  SESSION_COOKIE_NAME: string;
  shouldUseSecureCookies: (request: Request) => boolean;
  loginChallengeStore: LoginChallengeStore;

  generateIdentityAlias: (npub: string) => string;
  handleKeyTeleport: (request: Request) => Response | Promise<Response>;
  handleKeyTeleportRegistration: (request: Request) => Response | Promise<Response>;
  ensureGiteaUser: (config: any, npub: string, alias: string) => Promise<any>;

  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { UiRestricted: AccessAction };
  getViewerNormalizedNpub: (authContext: RequestAuthContext) => string | null;
  normaliseOptionalString: (value: unknown) => string | null;
  resolveAndCacheNostrProfile: (npub: string, opts: { force?: boolean; relays?: string[] }) => Promise<{
    pictureUrl: string | null;
    name?: string | null;
  }>;
  onSessionAuthenticated?: (npub: string) => void | Promise<void>;
}

// ---------- Main handler ----------

export async function handleAuthApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AuthApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // GET /api/auth/challenge — issue a short-lived, single-use login challenge.
  if (pathname === "/api/auth/challenge" && method === "GET") {
    try {
      return Response.json(ctx.loginChallengeStore.issue(), {
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return Response.json({ error: "Unable to issue login challenge" }, { status: 503 });
    }
  }

  // POST /api/auth/session — login / session creation
  if (pathname === "/api/auth/session" && method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const { npub, encryptedNsec, signedEvent, challenge } = payload as Record<string, unknown>;
    if (typeof npub !== "string" || npub.trim().length === 0) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }

    const trimmedNpub = npub.trim();
    if (typeof encryptedNsec !== "undefined" && encryptedNsec !== null && typeof encryptedNsec !== "string") {
      return Response.json({ error: "encryptedNsec must be a string" }, { status: 400 });
    }

    if (typeof challenge !== "string" || !LOGIN_CHALLENGE_PATTERN.test(challenge)) {
      return Response.json({ error: "challenge is required" }, { status: 400 });
    }
    if (!signedEvent || typeof signedEvent !== "object") {
      return Response.json({ error: "signedEvent is required" }, { status: 400 });
    }

    try {
      const signerNpub = signedLoginEventNpub(signedEvent, challenge, request, url, ctx);
      if (normaliseNpub(signerNpub) !== normaliseNpub(trimmedNpub)) {
        return Response.json({ error: "signedEvent.pubkey must match npub" }, { status: 400 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid signedEvent";
      return Response.json({ error: message }, { status: 400 });
    }

    if (!ctx.loginChallengeStore.consume(challenge)) {
      return Response.json({ error: "Login challenge is invalid, expired, or already used" }, { status: 401 });
    }

    try {
      // Block new registrations when REGISTER=FALSE
      if (!ctx.config.registrationEnabled) {
        const normalized = normaliseNpub(trimmedNpub);
        const existingUser = normalized ? ctx.identityUserStore.getByNormalized(normalized) : null;
        const isConfiguredAdmin = isConfiguredAdminNpub(ctx, normalized);
        if (!existingUser && !isConfiguredAdmin) {
          return Response.json({ error: "Registration is currently disabled" }, { status: 403 });
        }
      }

      const existingSession = authContext.session;
      if (existingSession && existingSession.npub !== trimmedNpub) {
        // Allow overwriting with a new npub, but clear stale signed data by minting a new cookie.
      }

      const { cookie, expiresAt, payload: cookiePayload } = ctx.mintSessionCookie(trimmedNpub, {
        secure: ctx.shouldUseSecureCookies(request),
      });
      authContext.npub = cookiePayload.npub;
      authContext.actorNpub = cookiePayload.npub;
      authContext.signerNpub = cookiePayload.npub;
      authContext.subjectNpub = cookiePayload.npub;
      authContext.targetOwnerNpub = cookiePayload.npub;
      authContext.delegatedOwnerNpub = null;
      authContext.delegateRelationshipId = null;
      authContext.delegateScopes = null;
      authContext.session = cookiePayload;
      delete authContext.error;
      const alias = ctx.generateIdentityAlias(trimmedNpub);
      try {
        ctx.identityUserStore.touch(trimmedNpub, {
          alias,
          lastSeenAt: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(`[admin] failed to record identity ${trimmedNpub}:`, error);
      }
      void ctx.onSessionAuthenticated?.(trimmedNpub);

      // Fire-and-forget Gitea user provisioning
      if (ctx.config.giteaUrl && ctx.config.giteaApiToken && ctx.config.giteaOwner) {
        ctx.ensureGiteaUser(ctx.config, trimmedNpub, alias).catch((err) => {
          console.warn(`[gitea] user provisioning failed for ${trimmedNpub}:`, err);
        });
      }

      const headers = new Headers({
        "cache-control": "no-store",
      });
      headers.append("set-cookie", cookie);
      return Response.json({ expiresAt }, { headers });
    } catch (error) {
      if (error instanceof ctx.SessionCookieError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to mint session cookie: ${message}` }, { status: 500 });
    }
  }

  // DELETE /api/auth/session — logout
  if (pathname === "/api/auth/session" && method === "DELETE") {
    const headers = new Headers({
      "cache-control": "no-store",
    });
    for (const secure of [true, false]) {
      const secureFlag = secure ? "; Secure" : "";
      headers.append(
        "set-cookie",
        `${ctx.getSessionCookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`,
      );
    }
    authContext.npub = null;
    authContext.actorNpub = null;
    authContext.signerNpub = null;
    authContext.subjectNpub = null;
    authContext.targetOwnerNpub = null;
    authContext.delegatedOwnerNpub = null;
    authContext.delegateRelationshipId = null;
    authContext.delegateScopes = null;
    authContext.session = null;
    delete authContext.error;
    return new Response(null, { status: 204, headers });
  }

  // POST /api/auth/keyteleport — receive encrypted key blob from Welcome
  if (pathname === "/api/auth/keyteleport" && method === "POST") {
    return ctx.handleKeyTeleport(request);
  }

  // GET /api/auth/keyteleport/config — keyteleport configuration
  if (pathname === "/api/auth/keyteleport/config" && method === "GET") {
    const { getKeyTeleportIdentity, KEYTELEPORT_WELCOME_URL } = await import("../config");
    const identity = getKeyTeleportIdentity();
    const isConfigured = Boolean(identity);
    return Response.json({
      enabled: isConfigured,
      welcomeUrl: isConfigured ? KEYTELEPORT_WELCOME_URL : null,
      appNpub: identity?.npub ?? null,
    });
  }

  // GET /api/auth/keyteleport/registration — registration blob
  if (pathname === "/api/auth/keyteleport/registration" && method === "GET") {
    return ctx.handleKeyTeleportRegistration(request);
  }

  // GET /api/identity/profile — profile lookup
  if (pathname === "/api/identity/profile" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.UiRestricted, request, url, authContext);
    if (denied) {
      return denied;
    }
    const viewerNormalized = ctx.getViewerNormalizedNpub(authContext);
    const viewerIsAdmin = isConfiguredAdminNpub(ctx, viewerNormalized);
    const targetInput = ctx.normaliseOptionalString(url.searchParams.get("npub")) ?? authContext.npub;
    const refresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
    if (!targetInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalizedTarget = normaliseNpub(targetInput);
    if (!normalizedTarget) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    if (!viewerIsAdmin && normalizedTarget !== viewerNormalized) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const profile = await ctx.resolveAndCacheNostrProfile(targetInput, {
        force: refresh,
        relays: ctx.config.connectRelays,
      });
      const record = ctx.identityUserStore.getByNormalized(normalizedTarget);
      return Response.json({
        npub: record?.npub ?? targetInput,
        name: profile.name ?? null,
        pictureUrl: profile.pictureUrl ?? record?.pictureUrl ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return null;
}
