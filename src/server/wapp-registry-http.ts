import type { RequestAuthContext } from "../auth/request-context";

/** Only registry reads are a browser surface; management routes retain their policy. */
export async function handleWappRegistryHttp(
  request: Request, url: URL, auth: RequestAuthContext,
  resolveAuth: (request: Request, url: URL, auth: RequestAuthContext) => Promise<RequestAuthContext>,
  read: (auth: RequestAuthContext) => Promise<Response>,
  allowedOrigins = process.env.WINGMAN_WAPP_CORS_ORIGINS ?? "",
): Promise<Response> {
  const origin = request.headers.get("origin");
  const permitted = origin !== null && origin !== "null" && allowedOrigins.split(",").map(o => o.trim()).includes(origin)
    && (() => { try { const u = new URL(origin); return ["http:", "https:"].includes(u.protocol) && u.origin === origin; } catch { return false; } })();
  if (origin && !permitted) return Response.json({ error: "cors_origin_denied" }, { status: 403 });
  function withCors(response: Response) {
    const headers = new Headers(response.headers);
    headers.append("Vary", "Origin");
    headers.set("Cache-Control", "private, no-store");
    if (permitted) {
      headers.set("Access-Control-Allow-Origin", origin!);
      headers.set("Access-Control-Allow-Methods", "GET");
      headers.set("Access-Control-Allow-Headers", "Authorization");
    }
    return new Response(response.body, { status: response.status, headers });
  }
  if (request.method === "OPTIONS") {
    const requested = (request.headers.get("access-control-request-headers") ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    const allowed = permitted && request.headers.get("access-control-request-method") === "GET" && requested.every(h => h === "authorization");
    return withCors(new Response(null, { status: allowed ? 204 : 403 }));
  }
  const effective = await resolveAuth(request, url, auth);
  if (origin && effective.authMethod !== "nip98") return withCors(Response.json({ error: "authentication_required" }, { status: 401 }));
  try { return withCors(await read(effective)); }
  catch { return withCors(Response.json({ error: "wapp_registry_unavailable" }, { status: 503 })); }
}
