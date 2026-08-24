import { finalizeEvent } from "nostr-tools";

import type { SessionSnapshot } from "../agents/process-manager";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { parseBody, jsonError } from "../utils/request-utils";
import {
  assertNip98SigningAllowed,
  assertNostrSigningAllowed,
  assertTokenSessionAllowed,
  type SigningCapabilityTokenPayload,
  verifySigningCapabilityToken,
} from "./capability-token";
import { signWithWingmanIdentity } from "../mcp/wingman-signer";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface SigningApiContext {
  signingSecret: string | null;
  getSession: (sessionId: string) => SessionSnapshot | null | undefined;
  getInstanceIdentity: () => WingmanInstanceIdentity | null;
}

interface AuthorizedSigningRequest {
  payload: SigningCapabilityTokenPayload;
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = authorization.slice("bearer ".length).trim();
  return token || null;
}

function normaliseBodyHash(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function parseStringArray(value: unknown): string[][] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) {
      return null;
    }
  }
  return value as string[][];
}

function authorizeRequest(request: Request, ctx: SigningApiContext): AuthorizedSigningRequest | Response {
  if (!ctx.signingSecret?.trim()) {
    return jsonError("Runner signing is not configured", 503);
  }

  const token = readBearerToken(request);
  if (!token) {
    return jsonError("Missing signing bearer token", 401);
  }

  const verification = verifySigningCapabilityToken(ctx.signingSecret, token);
  if (verification.ok === false) {
    return jsonError(verification.reason, 403);
  }

  return { payload: verification.payload };
}

function validateSession(ctx: SigningApiContext, sessionId: string | undefined): SessionSnapshot | null | Response {
  if (!sessionId) {
    return null;
  }
  const session = ctx.getSession(sessionId) ?? null;
  if (!session) {
    return jsonError("Unknown session", 404);
  }
  return session;
}

async function handleNip98Sign(request: Request, ctx: SigningApiContext): Promise<Response> {
  const authorized = authorizeRequest(request, ctx);
  if (authorized instanceof Response) {
    return authorized;
  }

  const body = await parseBody(request);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
  const sessionError = assertTokenSessionAllowed(authorized.payload, sessionId);
  if (sessionError) {
    return jsonError(sessionError, 403);
  }

  const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
  const method = typeof body.method === "string" ? body.method.trim().toUpperCase() : "";
  if (!targetUrl || !method) {
    return jsonError("url and method are required", 400);
  }

  const capabilityError = assertNip98SigningAllowed(authorized.payload, targetUrl, method);
  if (capabilityError) {
    return jsonError(capabilityError, 403);
  }

  const session = validateSession(ctx, sessionId);
  if (session instanceof Response) {
    return session;
  }

  const rawBodyHash = typeof body.bodyHash === "string" ? body.bodyHash.trim() : undefined;
  const bodyHash = normaliseBodyHash(rawBodyHash);
  if (rawBodyHash && !bodyHash) {
    return jsonError("bodyHash must be a 64-character hex SHA-256 digest", 400);
  }

  void session;
  const identity = ctx.getInstanceIdentity();
  if (!identity) {
    return jsonError("Wingman instance key not configured. Set WINGMAN_PRIV.", 503);
  }

  const result = {
    ...signWithWingmanIdentity(identity, targetUrl, method, bodyHash),
    signerType: "wingman",
  };
  return Response.json(result);
}

async function handleNostrEventSign(request: Request, ctx: SigningApiContext): Promise<Response> {
  const authorized = authorizeRequest(request, ctx);
  if (authorized instanceof Response) {
    return authorized;
  }

  const body = await parseBody(request);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
  const sessionError = assertTokenSessionAllowed(authorized.payload, sessionId);
  if (sessionError) {
    return jsonError(sessionError, 403);
  }

  const event = body.event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return jsonError("event is required", 400);
  }
  const eventRecord = event as Record<string, unknown>;
  const kind = eventRecord.kind;
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0) {
    return jsonError("event.kind must be a non-negative integer", 400);
  }

  const capabilityError = assertNostrSigningAllowed(authorized.payload, kind);
  if (capabilityError) {
    return jsonError(capabilityError, 403);
  }

  const session = validateSession(ctx, sessionId);
  if (session instanceof Response) {
    return session;
  }

  const content = eventRecord.content;
  const tags = parseStringArray(eventRecord.tags);
  if (typeof content !== "string") {
    return jsonError("event.content must be a string", 400);
  }
  if (!tags) {
    return jsonError("event.tags must be an array of string arrays", 400);
  }

  const identity = ctx.getInstanceIdentity();
  if (!identity) {
    return jsonError("Wingman instance key not configured. Set WINGMAN_PRIV.", 503);
  }

  const signedEvent = finalizeEvent({
    kind,
    content,
    tags,
    created_at: typeof eventRecord.created_at === "number"
      ? eventRecord.created_at
      : Math.floor(Date.now() / 1000),
  }, identity.secretKey);

  return Response.json({
    event: {
      id: signedEvent.id,
      pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at,
      kind: signedEvent.kind,
      tags: signedEvent.tags,
      content: signedEvent.content,
      sig: signedEvent.sig,
    },
    signerPubkey: identity.pubkeyHex,
  });
}

export async function handleSigningApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  ctx: SigningApiContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/internal/signing")) {
    return null;
  }
  if (method === "POST" && url.pathname === "/api/internal/signing/nip98") {
    return await handleNip98Sign(request, ctx);
  }
  if (method === "POST" && url.pathname === "/api/internal/signing/nostr-event") {
    return await handleNostrEventSign(request, ctx);
  }
  if (method === "GET" && url.pathname === "/api/internal/signing/status") {
    return Response.json({ configured: Boolean(ctx.signingSecret?.trim()), service: "wingman-runner-signing" });
  }
  return jsonError("Not found", 404);
}
