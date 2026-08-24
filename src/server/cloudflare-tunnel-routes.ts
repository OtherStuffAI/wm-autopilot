import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { CloudflareTunnelClient } from "../cloudflare/tunnel-hostnames";
import { CloudflareApiError } from "../cloudflare/tunnel-hostnames";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface CloudflareTunnelRoutesContext {
  AccessActions: {
    AppsManage: AccessAction;
  };
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  getClient: () => CloudflareTunnelClient | null;
}

function cloudflareErrorResponse(error: unknown): Response {
  if (error instanceof CloudflareApiError) {
    return Response.json({
      error: error.message,
      cloudflareErrors: error.errors,
    }, { status: error.status >= 400 ? error.status : 502 });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  return payload as Record<string, unknown>;
}

export async function handleCloudflareTunnelApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: CloudflareTunnelRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/cloudflare/tunnel-hostnames")) {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.AppsManage, request, url, authContext);
  if (denied) {
    return denied;
  }

  const client = ctx.getClient();
  if (!client) {
    return Response.json({
      error: "Cloudflare Tunnel is not configured. Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TUNNEL_ID, and CLOUDFLARE_ZONE_ID on the master Autopilot.",
    }, { status: 503 });
  }

  if (url.pathname === "/api/cloudflare/tunnel-hostnames" && method === "GET") {
    const hostname = url.searchParams.get("hostname");
    const serviceUrl = url.searchParams.get("serviceUrl");
    if (!hostname || !serviceUrl) {
      return Response.json({ error: "hostname and serviceUrl are required" }, { status: 400 });
    }
    try {
      const result = await client.verifyPublicHostname({ hostname, serviceUrl });
      return Response.json({ route: result });
    } catch (error) {
      return cloudflareErrorResponse(error);
    }
  }

  if (url.pathname === "/api/cloudflare/tunnel-hostnames" && method === "POST") {
    const payload = await readJsonObject(request);
    if (payload instanceof Response) {
      return payload;
    }
    const hostname = typeof payload.hostname === "string" ? payload.hostname : "";
    const serviceUrl = typeof payload.serviceUrl === "string" ? payload.serviceUrl : "";
    const tunnelId = typeof payload.tunnelId === "string" ? payload.tunnelId : null;
    try {
      const result = await client.upsertPublicHostname({ hostname, serviceUrl, tunnelId });
      return Response.json({ route: result }, { status: 201 });
    } catch (error) {
      return cloudflareErrorResponse(error);
    }
  }

  const match = url.pathname.match(/^\/api\/cloudflare\/tunnel-hostnames\/([^/]+)$/);
  if (match && method === "DELETE") {
    const hostname = decodeURIComponent(match[1] ?? "");
    const deleteDns = url.searchParams.get("deleteDns") === "true";
    try {
      const result = await client.removePublicHostname({ hostname, deleteDns });
      return Response.json(result);
    } catch (error) {
      return cloudflareErrorResponse(error);
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
