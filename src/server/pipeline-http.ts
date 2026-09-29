import { writeServerLog } from "../logging/server-logger";
import type { RequestAuthContext } from "../auth/request-context";
import { runWithRequestContext } from "../auth/request-context";
import { handlePipelineApi, type PipelineApiContext } from "../pipelines/pipeline-api-routes";

/** CORS applies only to the documented browser calling surface. No cookie credentials. */
export async function handlePipelineHttp(request: Request, url: URL, auth: RequestAuthContext, ctx: PipelineApiContext,
  resolveAuth: (request: Request, url: URL, auth: RequestAuthContext) => Promise<RequestAuthContext>,
  allowedOrigins = process.env.WINGMEN_PIPELINE_CORS_ORIGINS ?? "",
  publicBaseUrl = url.origin): Promise<Response | null> {
  const origin = request.headers.get("origin");
  const publicOrigin = new URL(publicBaseUrl.trim() || url.origin).origin;
  const crossOrigin = origin !== null && origin !== publicOrigin;
  const browserRoute = /^\/api\/pipelines\/(definitions(?:\/[^/]+\/runs)?|runs\/[^/]+(?:\/delivery)?|webhook-signer)$/.test(url.pathname);
  let permittedOrigin = false;
  if (origin && origin !== "null") {
    try {
      const parsed = new URL(origin);
      permittedOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin
        && allowedOrigins.split(",").map(o => o.trim()).includes(origin);
    } catch { permittedOrigin = false; }
  }
  if (crossOrigin && (!browserRoute || !permittedOrigin)) {
    return Response.json({ error: "Browser origin is not allowed", code: "cors_origin_denied" }, { status: 403 });
  }
  function withCors(response: Response): Response {
    if (!crossOrigin) return response;
    const headers = new Headers(response.headers);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Origin", origin!);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    headers.set("Access-Control-Expose-Headers", "Location");
    return new Response(response.body, { status: response.status, headers });
  }
  if (request.method === "OPTIONS" && browserRoute) {
    const method = request.headers.get("access-control-request-method");
    const headers = (request.headers.get("access-control-request-headers") ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    if (method && !["GET", "POST"].includes(method) || headers.some(h => !["authorization", "content-type", "idempotency-key"].includes(h))) {
      return withCors(Response.json({ error: "Preflight method or headers are not allowed" }, { status: 403 }));
    }
    return withCors(new Response(null, { status: 204 }));
  }
  const effective = await resolveAuth(request, url, auth);
  if (crossOrigin && effective.authMethod !== "nip98") {
    return withCors(Response.json({ error: "Cross-origin calls require explicit NIP-98 authentication" }, { status: 401 }));
  }
  try {
    const response = await runWithRequestContext(effective, () => handlePipelineApi(request, url,
      request.method as Parameters<typeof handlePipelineApi>[2], effective, ctx));
    return response ? withCors(response) : null;
  } catch (error) {
    writeServerLog("ERROR", "[pipelines] API request failed", error instanceof Error ? error.message : String(error));
    return withCors(Response.json({ error: "Pipeline API request failed", code: "pipeline_api_error" }, { status: 500 }));
  }
}
