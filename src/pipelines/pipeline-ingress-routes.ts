import { secretAuthorityFromAuth } from "../secrets/secret-authority";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import { generateIdentityAlias } from "../identity/identity-alias";
import type { PipelineApiContext } from "./pipeline-api-routes";
import { resumeStoredPipelineRun } from "./stored-run-resume";
import { acceptAgentCallback, startDeclarativePipeline } from "./pipeline-runner";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { builtinPipelineFunctions } from "./functions";
import type { JsonObject } from "./pipeline-store";
import { isHttpPipelineTriggerTokenAuthorized, normaliseOptionalString, getHttpTriggerPipelineDefinition, serializeDefinitionSummary } from "./pipeline-route-helpers";

export async function handlePipelineIngress(request: Request, url: URL, method: string, authContext: RequestAuthContext,
  ctx: PipelineApiContext): Promise<Response | null> {
  const pathname = url.pathname;
  const callbackMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps\/([^/]+)\/callback$/);
  if (callbackMatch && method === "POST") {
    const payload = await request.json().catch(() => null);
    const result = await acceptAgentCallback({
      store: ctx.store,
      runId: decodeURIComponent(callbackMatch[1]!),
      stepId: decodeURIComponent(callbackMatch[2]!),
      token: request.headers.get("x-wingmen-pipeline-token") ?? url.searchParams.get("token"),
      payload,
    });
    if (result.ok) {
      const runId = decodeURIComponent(callbackMatch[1]!);
      void resumeStoredPipelineRun(ctx, runId, ctx.callbackOrigin ?? url.origin).catch((error) => {
        ctx.store.addEvent({
          runId,
          level: "error",
          type: "run_resume_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return Response.json(result.body, { status: result.status });
  }

  const httpTriggerMatch = pathname.match(/^\/api\/pipelines\/triggers\/http\/([^/]+)$/);
  if (httpTriggerMatch && method === "POST") {
    const triggerTokenAuthorized = isHttpPipelineTriggerTokenAuthorized(request);
    if (!triggerTokenAuthorized) {
      const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
      if (denied) return denied;
    }
    const key = decodeURIComponent(httpTriggerMatch[1]!);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const submittedInput = body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? body.input as JsonObject
      : {};
    const ownerNpub = triggerTokenAuthorized
      ? normaliseOptionalString(body.ownerNpub)
      : getEffectiveOwnerNpub(authContext);
    const ownerAlias = triggerTokenAuthorized
      ? normaliseOptionalString(body.ownerAlias)
      : ownerNpub ? generateIdentityAlias(ownerNpub) : null;
    const definition = await getHttpTriggerPipelineDefinition(key, ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    const input = { ...(definition.spec.input ?? {}), ...submittedInput };
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const run = startDeclarativePipeline({
      store: ctx.store,
      sessionApiContext: ctx.sessionApiContext,
      definition,
      registry: functions.registry,
      input,
      ownerNpub,
      // The legacy shared trigger token authenticates no owner or agent principal.
      secretAuthority: triggerTokenAuthorized ? undefined : secretAuthorityFromAuth(authContext),
      ownerAlias,
      callbackOrigin: ctx.callbackOrigin ?? url.origin,
    });
    return Response.json({
      ok: true,
      trigger: "http",
      definition: serializeDefinitionSummary(definition),
      run,
    }, { status: 202 });
  }

  return null;
}
