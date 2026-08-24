export function firstForwardedHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function forwardedScheme(request: Request): "http" | "https" | null {
  const proto = firstForwardedHeaderValue(request.headers.get("x-forwarded-proto"));
  if (proto === "http" || proto === "https") {
    return proto;
  }

  const cfVisitor = request.headers.get("cf-visitor");
  if (!cfVisitor) {
    return null;
  }

  try {
    const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
    return parsed.scheme === "http" || parsed.scheme === "https" ? parsed.scheme : null;
  } catch {
    return null;
  }
}

function applyForwardedHost(url: URL, host: string): void {
  try {
    const parsed = new URL(`http://${host}`);
    url.hostname = parsed.hostname;
    url.port = parsed.port;
  } catch {
    url.host = host;
  }
}

export function forwardedRequestUrl(request: Request, fallbackUrl: URL): URL {
  const host = firstForwardedHeaderValue(request.headers.get("x-forwarded-host"));
  const proto = forwardedScheme(request);
  if (!host && !proto) {
    return fallbackUrl;
  }
  const publicUrl = new URL(fallbackUrl.toString());
  if (proto) publicUrl.protocol = `${proto}:`;
  if (host) applyForwardedHost(publicUrl, host);
  return publicUrl;
}

export function configuredPublicRequestUrl(fallbackUrl: URL, baseUrl: string): URL | null {
  const base = baseUrl.trim();
  if (!base) return null;
  try {
    return new URL(`${fallbackUrl.pathname}${fallbackUrl.search}`, base.replace(/\/$/, ""));
  } catch {
    return null;
  }
}

export function resolveHttpsRedirectUrl(request: Request, fallbackUrl: URL, baseUrl: string): string | null {
  let configuredBaseUrl: URL;
  try {
    configuredBaseUrl = new URL(baseUrl);
  } catch {
    return null;
  }

  if (configuredBaseUrl.protocol !== "https:") {
    return null;
  }

  const publicUrl = forwardedRequestUrl(request, fallbackUrl);
  if (publicUrl.protocol !== "http:") {
    return null;
  }

  if (publicUrl.host !== configuredBaseUrl.host) {
    return null;
  }

  return new URL(`${publicUrl.pathname}${publicUrl.search}`, configuredBaseUrl.origin).toString();
}

export function redirectInsecurePublicRequest(request: Request, fallbackUrl: URL, baseUrl: string): Response | null {
  const redirectUrl = resolveHttpsRedirectUrl(request, fallbackUrl, baseUrl);
  return redirectUrl ? Response.redirect(redirectUrl, 308) : null;
}
