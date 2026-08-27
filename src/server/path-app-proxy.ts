import { handleAppWebSocketUpgrade, type AppWebSocketUpgradeServer } from "./app-websocket-proxy";
import {
  proxyRequestToApp,
  resolveAliasToPort,
  type ResolveAliasResult,
} from "./subdomain-proxy";

export interface PathAppProxyDependencies {
  resolveAlias(alias: string): Promise<ResolveAliasResult>;
  proxyRequest(request: Request, targetPort: number): Promise<Response>;
}

const defaultDependencies: PathAppProxyDependencies = {
  resolveAlias: resolveAliasToPort,
  proxyRequest: proxyRequestToApp,
};

/**
 * Handle path-based app routing (/host/<alias> and /host/<alias>/*).
 * Extracts the alias, removes the public prefix, and proxies to the app port.
 */
export const handlePathBasedAppRequest = async (
  request: Request,
  pathname: string,
  requestServer: AppWebSocketUpgradeServer,
  dependencies: PathAppProxyDependencies = defaultDependencies,
): Promise<Response | null> => {
  const pathParts = pathname.split("/").filter(Boolean);
  if (pathParts.length < 2 || pathParts[0] !== "host") {
    return null;
  }

  const alias = pathParts[1];
  if (!alias) {
    return null;
  }

  // Preserve relative asset resolution by canonicalising the app root URL.
  if (pathParts.length === 2 && !pathname.endsWith("/") && request.method === "GET") {
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}${pathname}/${url.search}`, 302);
  }

  const resolved = await dependencies.resolveAlias(alias);
  if (!resolved.success) {
    const errorMessages: Record<string, string> = {
      alias_not_found: `No app registered for alias "${alias}".`,
      app_not_found: `App ID ${resolved.appId} not found in registry.`,
      app_not_running: `App is not running (status: ${resolved.status}).`,
      port_not_registered: "App is running but port not detected. Try restarting the app.",
      invalid_runtime_port: `App resolved to an invalid runtime port (${resolved.port}). Restart the app so its assigned port can be registered.`,
    };
    console.warn(`[path-proxy] ${alias}: ${resolved.reason}`, resolved);
    return new Response(
      JSON.stringify({
        error: "App not available",
        reason: resolved.reason,
        message: errorMessages[resolved.reason],
        alias,
        appId: resolved.appId,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const remainingPath = `/${pathParts.slice(2).join("/")}`;
  const url = new URL(request.url);
  const rewrittenUrl = new URL(remainingPath + url.search, request.url);
  const rewrittenRequest = new Request(rewrittenUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: "half",
  });

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleAppWebSocketUpgrade(rewrittenRequest, resolved.port, requestServer) ?? null;
  }

  return dependencies.proxyRequest(rewrittenRequest, resolved.port);
};
