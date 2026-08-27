export type BrowserSecurityBoundary = "control-plane" | "managed-app";
export type ManagedAppProxyForm = "hostname" | "path";

const hasFrameAncestorsDirective = (headers: Headers): boolean => {
  const contentSecurityPolicy = headers.get("Content-Security-Policy");
  if (!contentSecurityPolicy) {
    return false;
  }

  return /(?:^|[;,])\s*frame-ancestors(?:\s|[;,]|$)/i.test(contentSecurityPolicy);
};

/**
 * Apply browser headers at the Autopilot/managed-app security boundary.
 *
 * Control-plane responses always deny framing. Managed apps retain an explicit
 * upstream X-Frame-Options or CSP frame-ancestors policy. If the app supplies
 * neither, SAMEORIGIN is the safe default so app pages can embed one another
 * without becoming frameable by unrelated origins.
 */
export const applyBrowserSecurityHeaders = (
  response: Response,
  boundary: BrowserSecurityBoundary,
): Response => {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (boundary === "control-plane") {
    headers.set("X-Frame-Options", "DENY");
  } else if (!headers.get("X-Frame-Options")?.trim() && !hasFrameAncestorsDirective(headers)) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export interface BrowserSecurityHeadersContext {
  markManagedAppResponse(response: Response, proxyForm: ManagedAppProxyForm): Response;
  apply(response: Response): Response;
}

/** Create request-local policy state shared by the router and final middleware. */
export const createBrowserSecurityHeadersContext = (): BrowserSecurityHeadersContext => {
  let managedAppProxyForm: ManagedAppProxyForm | null = null;

  return {
    markManagedAppResponse(response, proxyForm) {
      managedAppProxyForm = proxyForm;
      return response;
    },
    apply(response) {
      return applyBrowserSecurityHeaders(
        response,
        managedAppProxyForm === null ? "control-plane" : "managed-app",
      );
    },
  };
};
