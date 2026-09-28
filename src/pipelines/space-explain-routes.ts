import type { RequestAuthContext } from "../auth/request-context";
import { spaceExplainRequest } from "./space-explain-contract";
import { getExplainService, serializeExplainRun } from "./space-explain-service";
import type { PipelineApiContext } from "./pipeline-api-routes";
import { readBoundedText } from "./space-explain-runtime";

const BASE = "/api/pipelines/space-explain.v1";

/** Isolated app contract: no generic definition, run, step, callback, event or session IDs. */
export async function handleSpaceExplainApi(request: Request, url: URL, auth: RequestAuthContext,
  ctx: PipelineApiContext): Promise<Response | null> {
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  const origin = request.headers.get("origin");
  const origins = (process.env.SPACE_EXPLAIN_APP_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: {
    "cache-control": "no-store", "vary": "Origin",
    ...(origin && origins.includes(origin) ? { "access-control-allow-origin": origin } : {}),
  } });
  if (origin && !origins.includes(origin)) return respond({ code: "origin_denied" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    ...(origin ? { "access-control-allow-origin": origin } : {}), "vary": "Origin", "cache-control": "no-store",
    "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type",
  } });
  if (url.search) return respond({ code: "invalid_request" }, 400);
  // Ignore delegatedOwnerNpub/advisory owner. Personal NIP-98 signer owns every row.
  const owner = auth.signerNpub;
  if (auth.authMethod !== "nip98" || !owner || auth.npub !== owner) return respond({ code: "nip98_required" }, 401);
  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url,
    { ...auth, targetOwnerNpub: owner, delegatedOwnerNpub: null, advisoryOwnerNpub: null });
  if (denied) return respond({ code: "access_denied" }, denied.status);
  const service = getExplainService(ctx);
  if (url.pathname === `${BASE}/runs` && request.method === "POST") {
    if (process.env.SPACE_EXPLAIN_ENABLED !== "1" && !ctx.spaceExplainService) return respond({ code: "space_explain_unavailable" }, 503);
    let input;
    try { input = spaceExplainRequest.parse(JSON.parse(await readBoundedText(request.body, 16_000))); }
    catch { return respond({ code: "invalid_request" }, 400); }
    try {
      const { run, replayed } = service.create(owner, input);
      return respond({ run: serializeExplainRun(run), replayed }, replayed ? 200 : 202);
    } catch (error) {
      const code = error instanceof Error ? error.message : "request_failed";
      if (code === "idempotency_conflict") return respond({ code }, 409);
      if (code === "rate_limited") return respond({ code }, 429);
      return respond({ code: "request_failed" }, 500);
    }
  }
  const match = url.pathname.match(/^\/api\/pipelines\/space-explain\.v1\/runs\/([a-f0-9-]{36})(\/output)?$/);
  if (match && request.method === "GET") {
    const run = service.store.get(owner, match[1]!);
    if (!run) return respond({ code: "run_not_found" }, 404);
    if (match[2] && run.status !== "completed") return respond({ code: "output_not_ready", status: run.status, error: run.error }, 409);
    return respond(match[2] ? { response: serializeExplainRun(run).response } : { run: serializeExplainRun(run) });
  }
  // No list, steps/events, analysis, resume, or callback endpoints exist for this private worker.
  return respond({ code: "not_found" }, 404);
}
