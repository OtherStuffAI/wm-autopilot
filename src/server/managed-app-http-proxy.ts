const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const VITE_HASHED_ASSET_PATH = /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const logProxy = (message: string, data?: unknown): void => {
  if (Bun.env.WINGMAN_ROUTING_DEBUG !== "1") {
    return;
  }
  console.debug(data ? `[subdomain-proxy] ${message}` : `[subdomain-proxy] ${message}`, data ?? "");
};

export const isViteHashedAssetPath = (pathname: string): boolean =>
  VITE_HASHED_ASSET_PATH.test(pathname);

const shouldUseImmutableAssetCaching = (
  request: Request,
  response: Response,
): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  if (!isViteHashedAssetPath(pathname)) {
    return false;
  }

  if (![200, 206, 304].includes(response.status)) {
    return false;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    return false;
  }

  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  return !cacheControl.includes("private")
    && !cacheControl.includes("no-store")
    && !response.headers.has("set-cookie");
};

export const buildManagedAppResponseHeaders = (
  request: Request,
  response: Response,
  targetUrl: URL,
): Headers => {
  const responseHeaders = new Headers();
  for (const [key, value] of response.headers) {
    const lower = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(lower)
      && lower !== "content-length"
      && lower !== "content-encoding"
      && lower !== "set-cookie"
    ) {
      responseHeaders.set(key, value);
    }
  }

  for (const cookie of response.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }

  if (shouldUseImmutableAssetCaching(request, response)) {
    responseHeaders.set("cache-control", IMMUTABLE_ASSET_CACHE_CONTROL);
  }

  const location = response.headers.get("location");
  if (location) {
    const publicUrl = new URL(request.url);
    const resolvedLocation = new URL(location, targetUrl);
    if (
      resolvedLocation.hostname === "127.0.0.1"
      || resolvedLocation.hostname === "localhost"
      || resolvedLocation.host === publicUrl.host
    ) {
      responseHeaders.set(
        "location",
        `${publicUrl.origin}${resolvedLocation.pathname}${resolvedLocation.search}${resolvedLocation.hash}`,
      );
    }
  }

  return responseHeaders;
};

/** Proxy a managed-app request without delaying response headers for the full body. */
export const proxyRequestToApp = async (
  request: Request,
  targetPort: number,
): Promise<Response> => {
  const publicUrl = new URL(request.url);
  const targetUrl = new URL(
    publicUrl.pathname + publicUrl.search,
    `http://127.0.0.1:${targetPort}`,
  );
  logProxy("proxyRequestToApp", {
    targetPort,
    targetUrl: targetUrl.toString(),
    method: request.method,
  });

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  headers.set("X-Forwarded-Host", publicUrl.host);
  headers.set("X-Forwarded-Proto", publicUrl.protocol.replace(":", ""));
  headers.set("X-Forwarded-For", request.headers.get("x-forwarded-for") ?? "127.0.0.1");

  try {
    const proxyResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
      redirect: "manual",
    });
    const responseHeaders = buildManagedAppResponseHeaders(request, proxyResponse, targetUrl);
    logProxy("proxy fetch success", {
      targetPort,
      status: proxyResponse.status,
      contentLength: proxyResponse.headers.get("content-length"),
    });

    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logProxy("proxy fetch FAILED", { targetPort, error: message });
    console.error(`[subdomain-proxy] Failed to proxy to port ${targetPort}: ${message}`);

    return Response.json(
      {
        error: "App unavailable",
        message: "The application is not responding. It may be starting up or has stopped.",
      },
      { status: 502 },
    );
  }
};
