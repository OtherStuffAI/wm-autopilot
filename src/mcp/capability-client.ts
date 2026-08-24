import { createHash, randomUUID } from "node:crypto";

const REFRESH_AFTER_MS = 90 * 60_000;
const REFRESH_INTERVAL_MS = 90 * 60_000;
let cachedCapabilityToken = "";
let cachedCapabilityStartedAt = Date.now();
let cachedCapabilitySessionId = "";
let cachedCapabilityWingmanUrl = "";

export interface CapabilityClientContext {
  wingmanUrl: string;
  sessionId: string;
  capabilityToken: string;
  fetch?: typeof globalThis.fetch;
}

export class CapabilityRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly metadata: Record<string, unknown>;

  constructor(message: string, retryAfterMs: number, metadata: Record<string, unknown>) {
    super(message);
    this.name = "CapabilityRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.metadata = metadata;
  }
}

export function capabilityClientContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CapabilityClientContext {
  const wingmanUrl = env.WINGMAN_BROKER_URL?.trim() || env.WINGMAN_URL?.trim() || "";
  const sessionId = env.SESSION_ID?.trim() ?? "";
  const capabilityToken = env.WINGMAN_CAPABILITY?.trim() ?? "";
  if (!wingmanUrl || !sessionId || !capabilityToken) {
    throw new Error("Wingman capability context is unavailable; request a scoped session capability instead of a private key");
  }
  return { wingmanUrl: wingmanUrl.replace(/\/$/, ""), sessionId, capabilityToken };
}

export async function callCapabilityBroker<T>(
  path: string,
  body: Record<string, unknown>,
  context: CapabilityClientContext = capabilityClientContextFromEnv(),
): Promise<T> {
  const contextWingmanUrl = context.wingmanUrl.replace(/\/$/, "");
  const sameCapabilityContext = cachedCapabilitySessionId === context.sessionId
    && cachedCapabilityWingmanUrl === contextWingmanUrl;
  if (!sameCapabilityContext) {
    cachedCapabilityToken = context.capabilityToken;
    cachedCapabilityStartedAt = Date.now();
    cachedCapabilitySessionId = context.sessionId;
    cachedCapabilityWingmanUrl = contextWingmanUrl;
  } else if (!cachedCapabilityToken) {
    cachedCapabilityToken = context.capabilityToken;
  }
  if (sameCapabilityContext && context.capabilityToken === process.env.WINGMAN_CAPABILITY && cachedCapabilityToken !== context.capabilityToken) {
    context = { ...context, capabilityToken: cachedCapabilityToken };
  }
  if (Date.now() - cachedCapabilityStartedAt >= REFRESH_AFTER_MS) {
    context = await refreshCapability(context);
  }
  let response = await requestCapability(path, body, context);
  if (response.status === 403 && await isExpiredCapabilityResponse(response)) {
    context = await refreshCapability(context);
    response = await requestCapability(path, body, context);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string; code?: string; rateLimit?: { retryAfterMs?: number } };
    if (response.status === 429 && error.code === "capability_rate_limited") {
      const headerSeconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(error.rateLimit?.retryAfterMs)
        ? Number(error.rateLimit?.retryAfterMs)
        : Number.isFinite(headerSeconds) ? headerSeconds * 1_000 : 60_000;
      throw new CapabilityRateLimitError(error.error ?? "Capability broker rate limit exceeded", retryAfterMs, error as Record<string, unknown>);
    }
    throw new Error(error.error ?? `Capability broker request failed (${response.status})`);
  }
  return await response.json() as T;
}

function requestCapability(
  path: string,
  body: Record<string, unknown>,
  context: CapabilityClientContext,
): Promise<Response> {
  const fetchImpl = context.fetch ?? globalThis.fetch;
  return fetchImpl(`${context.wingmanUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.capabilityToken}`,
      "content-type": "application/json",
      "x-wingman-capability-nonce": randomUUID(),
    },
    body: JSON.stringify({ ...body, sessionId: context.sessionId }),
  });
}

async function isExpiredCapabilityResponse(response: Response): Promise<boolean> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: unknown };
  return payload.error === "Capability has expired";
}

async function refreshCapability(context: CapabilityClientContext): Promise<CapabilityClientContext> {
  const fetchImpl = context.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${context.wingmanUrl}/api/mcp/capabilities/refresh`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.capabilityToken}`,
      "content-type": "application/json",
      "x-wingman-capability-nonce": randomUUID(),
    },
    body: JSON.stringify({ sessionId: context.sessionId }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Capability refresh failed (${response.status})`);
  }
  const result = await response.json() as { token: string };
  cachedCapabilityToken = result.token;
  cachedCapabilityStartedAt = Date.now();
  cachedCapabilitySessionId = context.sessionId;
  cachedCapabilityWingmanUrl = context.wingmanUrl.replace(/\/$/, "");
  process.env.WINGMAN_CAPABILITY = result.token;
  return { ...context, capabilityToken: result.token };
}

/** Keep an idle MCP subprocess inside the broker's short capability lifetime. */
export function startCapabilityRefreshLoop(
  context: CapabilityClientContext = capabilityClientContextFromEnv(),
): () => void {
  let currentContext = context;
  const timer = setInterval(() => {
    void refreshCapability(currentContext)
      .then((refreshed) => {
        currentContext = refreshed;
      })
      .catch(() => {
        // The next broker call surfaces the authorization failure. Never log
        // response bodies here because they could contain sensitive payloads.
      });
  }, REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function readCapabilityIdentity(
  context: CapabilityClientContext = capabilityClientContextFromEnv(),
): Promise<{ identityType: "agent"; botNpub: string; botPubkeyHex: string; ownerNpub: string }> {
  const fetchImpl = context.fetch ?? globalThis.fetch;
  const url = `${context.wingmanUrl}/api/mcp/capabilities/identity?sessionId=${encodeURIComponent(context.sessionId)}`;
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${context.capabilityToken}`,
      "x-wingman-capability-nonce": randomUUID(),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Capability broker identity request failed (${response.status})`);
  }
  return await response.json() as {
    identityType: "agent";
    botNpub: string;
    botPubkeyHex: string;
    ownerNpub: string;
  };
}

export async function capabilityNip98Fetch(
  targetUrl: string,
  init: RequestInit = {},
  context: CapabilityClientContext = capabilityClientContextFromEnv(),
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const bodyText = typeof init.body === "string" ? init.body : undefined;
  const bodyHash = bodyText ? createHash("sha256").update(bodyText).digest("hex") : undefined;
  const signed = await callCapabilityBroker<{ token: string }>(
    "/api/mcp/capabilities/nip98",
    { url: targetUrl, method, bodyHash },
    context,
  );
  const headers = new Headers(init.headers);
  headers.set("authorization", signed.token);
  return await (context.fetch ?? globalThis.fetch)(targetUrl, { ...init, method, headers });
}
