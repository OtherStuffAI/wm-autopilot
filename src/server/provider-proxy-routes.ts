import type { SessionSnapshot } from "../agents/process-manager";
import type { TeamBillingService } from "../billing/team-billing-service";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type ProviderKind = "openai" | "anthropic" | "openrouter";

export interface ProviderProxyApiContext {
  billingService: TeamBillingService;
  getSession: (sessionId: string) => SessionSnapshot | null;
  ensureProviderApiKey: () => Promise<string | null>;
}

const PROVIDER_PREFIX = "/api/provider/";

const PROVIDER_TARGET_BASE: Record<ProviderKind, string> = {
  openai: "https://openrouter.ai/api/v1",
  anthropic: "https://openrouter.ai/api",
  openrouter: "https://openrouter.ai",
};

const sensitiveRequestHeaders = new Set([
  "authorization",
  "x-api-key",
  "content-length",
  "host",
]);

const normaliseTokenCandidate = (value: string | null): string | null => {
  if (!value) return null;
  let token = value.trim();
  if (!token) return null;
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice("bearer ".length).trim();
  }
  if (
    (token.startsWith("\"") && token.endsWith("\"")) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token || null;
};

const extractProxyTokenCandidates = (request: Request): string[] => {
  const candidates = [
    normaliseTokenCandidate(request.headers.get("authorization")),
    normaliseTokenCandidate(request.headers.get("x-api-key")),
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(candidates));
};

const describeTokenCandidate = (candidate: string): string => {
  const segmentCount = candidate.split(".").length;
  return `len=${candidate.length},segments=${segmentCount}`;
};

/** Permitted upstream API path prefixes. Requests outside this set are rejected. */
const ALLOWED_PATH_PREFIXES = [
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/models",
  "/v1/messages",
  "/api/v1/chat/completions",
  "/api/v1/completions",
  "/api/v1/responses",
  "/api/v1/embeddings",
  "/api/v1/models",
  "/api/v1/messages",
];

const isAllowedPath = (restPath: string): boolean =>
  ALLOWED_PATH_PREFIXES.some((prefix) => restPath === prefix || restPath.startsWith(prefix + "/") || restPath.startsWith(prefix + "?"));

const parseProviderKindAndPath = (pathname: string): { provider: ProviderKind; restPath: string } | null => {
  if (!pathname.startsWith(PROVIDER_PREFIX)) return null;
  const remainder = pathname.slice(PROVIDER_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  const providerRaw = (slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder).trim().toLowerCase();
  const rest = slashIndex >= 0 ? remainder.slice(slashIndex) : "/";
  if (providerRaw !== "openai" && providerRaw !== "anthropic" && providerRaw !== "openrouter") return null;
  const restPath = rest || "/";
  if (!isAllowedPath(restPath)) return null;
  return { provider: providerRaw, restPath };
};

const buildUpstreamUrl = (provider: ProviderKind, restPath: string, search: string): string => {
  const base = PROVIDER_TARGET_BASE[provider];
  const normalizedPath = restPath.startsWith("/") ? restPath : `/${restPath}`;
  return `${base}${normalizedPath}${search || ""}`;
};

const pickProviderRequestId = (headers: Headers): string | null =>
  headers.get("x-request-id") ??
  headers.get("x-openrouter-request-id") ??
  headers.get("x-oai-request-id") ??
  null;

const isJsonResponse = (headers: Headers): boolean => {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json");
};

const isSseResponse = (headers: Headers): boolean => {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream");
};

const parseSseDataPayload = (rawEvent: string): unknown | null => {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const payloadText = dataLines.join("\n").trim();
  if (!payloadText || payloadText === "[DONE]") return null;
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
};

const createSseCostMonitor = (
  stream: ReadableStream<Uint8Array>,
  parseCost: (headers: Headers, body: unknown) => number,
  initialCostUsd: number,
): { clientStream: ReadableStream<Uint8Array>; done: Promise<number> } => {
  const [clientStream, monitorStream] = stream.tee();
  const done = (async () => {
    const reader = monitorStream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let latestCostUsd = initialCostUsd;

    const processBuffer = (flush = false) => {
      while (true) {
        const splitIndex = buffer.indexOf("\n\n");
        if (splitIndex < 0) break;
        const rawEvent = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        const payload = parseSseDataPayload(rawEvent);
        if (!payload) continue;
        const parsed = parseCost(new Headers(), payload);
        if (parsed > 0) {
          latestCostUsd = parsed;
        }
      }
      if (flush && buffer.trim().length > 0) {
        const payload = parseSseDataPayload(buffer);
        if (payload) {
          const parsed = parseCost(new Headers(), payload);
          if (parsed > 0) {
            latestCostUsd = parsed;
          }
        }
        buffer = "";
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        processBuffer(false);
      }
      buffer += decoder.decode();
      processBuffer(true);
    } catch {
      // Ignore parse/stream errors; caller falls back to initial/header cost.
    }

    return latestCostUsd;
  })();

  return { clientStream, done };
};

const cloneProxyRequestHeaders = (request: Request, teamApiKey: string, provider: ProviderKind): Headers => {
  const outgoing = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (sensitiveRequestHeaders.has(key.toLowerCase())) continue;
    outgoing.set(key, value);
  }
  outgoing.set("Authorization", `Bearer ${teamApiKey}`);
  if (provider === "anthropic") {
    outgoing.set("x-api-key", teamApiKey);
  }
  if (!outgoing.get("HTTP-Referer")) {
    outgoing.set("HTTP-Referer", "https://wingman.local");
  }
  if (!outgoing.get("X-Title")) {
    outgoing.set("X-Title", "Wingman");
  }
  return outgoing;
};

export async function handleProviderProxyApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  ctx: ProviderProxyApiContext,
): Promise<Response | null> {
  const parsed = parseProviderKindAndPath(url.pathname);
  if (!parsed) return null;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!ctx.billingService.isCreditsEnabled()) {
    return Response.json({ error: "credits-disabled" }, { status: 403 });
  }

  const tokenCandidates = extractProxyTokenCandidates(request);
  if (tokenCandidates.length === 0) {
    return Response.json({ error: "missing-proxy-token" }, { status: 401 });
  }
  let payload: ReturnType<TeamBillingService["verifySessionProxyToken"]> = null;
  for (const candidate of tokenCandidates) {
    payload = ctx.billingService.verifySessionProxyToken(candidate);
    if (payload) break;
  }
  if (!payload) {
    console.warn(
      `[billing-proxy] invalid token for ${parsed.provider}${parsed.restPath}: ${
        tokenCandidates.map(describeTokenCandidate).join(" | ")
      }`,
    );
    return Response.json({ error: "invalid-proxy-token" }, { status: 401 });
  }

  const session = ctx.getSession(payload.sid);
  if (!session || session.status !== "running") {
    return Response.json({ error: "session-not-running" }, { status: 403 });
  }
  if (payload.npub && session.npub && payload.npub !== session.npub) {
    return Response.json({ error: "session-owner-mismatch" }, { status: 403 });
  }
  if (session.metadata?.billingMode !== "credits") {
    return Response.json({ error: "session-not-credits-enabled" }, { status: 403 });
  }

  const teamApiKey = await ctx.ensureProviderApiKey();
  if (!teamApiKey) {
    return Response.json({ error: "team-provider-key-unavailable" }, { status: 503 });
  }

  const upstreamUrl = buildUpstreamUrl(parsed.provider, parsed.restPath, url.search);
  const outgoingHeaders = cloneProxyRequestHeaders(request, teamApiKey, parsed.provider);
  const bodyRequired = !["GET", "HEAD"].includes(method);
  const upstreamBody = bodyRequired ? Buffer.from(await request.arrayBuffer()) : undefined;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: outgoingHeaders,
      body: upstreamBody,
      redirect: "manual",
    });
  } catch (error) {
    console.error(`[billing-proxy] provider request failed for ${parsed.provider}${parsed.restPath}:`, (error as Error).message);
    return Response.json({ error: "provider-request-failed" }, { status: 502 });
  }

  const upstreamHeaders = new Headers(upstreamResponse.headers);
  upstreamHeaders.delete("content-length");

  const providerRequestId = pickProviderRequestId(upstreamResponse.headers);
  const headerCostUsd = ctx.billingService.parseProxyCost(upstreamResponse.headers, null);

  if (isSseResponse(upstreamResponse.headers)) {
    const sourceBody = upstreamResponse.body;
    if (!sourceBody) {
      void ctx.billingService.recordProxyUsage({
        sessionId: session.id,
        npub: session.npub ?? null,
        agent: session.agent,
        endpoint: parsed.restPath,
        method,
        statusCode: upstreamResponse.status,
        providerRequestId,
        costUsd: headerCostUsd,
      });
      return new Response(null, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamHeaders,
      });
    }

    const monitor = createSseCostMonitor(
      sourceBody,
      (headers, body) => ctx.billingService.parseProxyCost(headers, body),
      headerCostUsd,
    );
    void monitor.done.then((finalCostUsd) =>
      ctx.billingService.recordProxyUsage({
        sessionId: session.id,
        npub: session.npub ?? null,
        agent: session.agent,
        endpoint: parsed.restPath,
        method,
        statusCode: upstreamResponse.status,
        providerRequestId,
        costUsd: finalCostUsd,
      }),
    );

    return new Response(monitor.clientStream, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamHeaders,
    });
  }

  let parsedBodyForCost: unknown = null;
  if (isJsonResponse(upstreamResponse.headers)) {
    parsedBodyForCost = await upstreamResponse.clone().json().catch(() => null);
  }
  const parsedCostUsd = ctx.billingService.parseProxyCost(upstreamResponse.headers, parsedBodyForCost);
  void ctx.billingService.recordProxyUsage({
    sessionId: session.id,
    npub: session.npub ?? null,
    agent: session.agent,
    endpoint: parsed.restPath,
    method,
    statusCode: upstreamResponse.status,
    providerRequestId,
    costUsd: parsedCostUsd > 0 ? parsedCostUsd : headerCostUsd,
  });

  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  return new Response(responseBuffer, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: upstreamHeaders,
  });
}
