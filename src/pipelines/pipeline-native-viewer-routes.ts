import type { RequestAuthContext } from "../auth/request-context";
import { generateIdentityAlias } from "../identity/identity-alias";
import type { PipelineApiContext } from "./pipeline-api-routes";
import { classifierOpenRouterSecrets } from "./classifier-openrouter-credentials";
import { listLatestPipelineDefinitions } from "./pipeline-loader";
import { viewerDefinition, viewerSnapshot } from "./pipeline-viewer-dto";
import { retainedSanitizedDefinition } from "./pipeline-viewer-routes";

// Native sessions can inspect their own executions. Delegates must use the
// signed control-plane adapter with its trusted workspace/agent context.
export async function handleNativePipelineViewerApi(
  request: Request,
  url: URL,
  auth: RequestAuthContext,
  ctx: PipelineApiContext,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/pipelines\/viewer(?:\/(.*))?$/);
  if (!match) return null;
  const reply = (body: Record<string, unknown>, status = 200) =>
    Response.json(
      ctx.store.evidence.sanitize({ version: 1, serviceId: "native", ...body })
        .value,
      { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } },
    );
  if (request.method !== "GET")
    return reply({ error: "method-not-allowed" }, 405);
  const owner = auth.session?.npub;
  if (
    auth.authMethod !== "session" ||
    !owner ||
    auth.npub !== owner ||
    auth.error ||
    auth.delegatedOwnerNpub ||
    auth.delegateRelationshipId ||
    (auth.targetOwnerNpub && auth.targetOwnerNpub !== owner)
  ) {
    return reply({ error: "native-owner-session-required" }, 403);
  }
  const denied = await ctx.ensureApiAccess(
    ctx.AccessActions.SessionsManage,
    request,
    url,
    auth,
  );
  if (denied)
    return new Response(denied.body, {
      status: denied.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  for (const secret of classifierOpenRouterSecrets({
    ownerNpub: owner,
    sessionApiContext: ctx.sessionApiContext,
  }))
    ctx.store.evidence.registerSecret(secret);
  try {
    const parts = (match[1] ?? "").split("/").map(decodeURIComponent);
    if (parts[0] === "definitions" && parts.length === 2) {
      const definitions = await listLatestPipelineDefinitions(
        generateIdentityAlias(owner),
      );
      const definition = definitions.find((item) => item.id === parts[1]);
      return definition
        ? reply({
            definition: viewerDefinition(
              retainedSanitizedDefinition(ctx.store, owner, definition),
              undefined,
              undefined,
              ctx.store.evidence.sanitize.bind(ctx.store.evidence),
            ),
          })
        : reply({ error: "not-found" }, 404);
    }
    if (
      parts[0] !== "runs" ||
      !parts[1] ||
      !nativeViewerOwnsRun(ctx, parts[1], owner)
    )
      return reply({ error: "not-found" }, 404);
    const runId = parts[1];
    if (parts.length === 4 && parts[2] === "evidence") {
      const offset = pageInteger(url, "offset", 0, Number.MAX_SAFE_INTEGER);
      const limit = pageInteger(url, "limit", 100, 500, 1);
      ctx.store.evidence.assertViewerSafe(runId);
      const record = ctx.store.evidence.get(runId, parts[3]!);
      if (!record) return reply({ error: "not-found" }, 404);
      if (!Array.isArray(record.value)) {
        if (offset) return reply({ error: "offset-only-for-array" }, 400);
        return reply({ ...record, nextOffset: null });
      }
      return reply({
        evidence: record.evidence,
        value: record.value.slice(offset, offset + limit),
        nextOffset:
          offset + limit < record.value.length ? offset + limit : null,
      });
    }
    if (parts.length !== 2 && !(parts.length === 3 && parts[2] === "updates"))
      return reply({ error: "not-found" }, 404);
    if (!nativeViewerValidChildLinks(ctx, runId, owner))
      return reply({ error: "invalid-run-ancestry" }, 409);
    const snapshot = ctx.store.composition.transaction(() => {
      try {
        return viewerSnapshot(runId, ctx.store, "native");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "pipeline-viewer-evidence-redaction-review-required"
        )
          return error;
        throw error;
      }
    });
    if (snapshot instanceof Error) throw snapshot;
    // Never leak foreign/malformed child links through the parent projection.
    if (
      snapshot.children.some(
        (child) => !nativeViewerOwnsRun(ctx, child.id, owner),
      )
    )
      return reply({ error: "invalid-run-ancestry" }, 409);
    return reply({
      ...snapshot,
      ...(parts[2] === "updates"
        ? { unchanged: url.searchParams.get("after") === snapshot.revision }
        : {}),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "pipeline-viewer-evidence-redaction-review-required"
    )
      return reply({ error: error.message }, 409);
    if (
      error instanceof URIError ||
      (error instanceof Error && error.message.startsWith("invalid-"))
    )
      return reply({ error: "invalid-request" }, 400);
    throw error;
  }
}

export function nativeViewerOwnsRun(
  ctx: Pick<PipelineApiContext, "store">,
  runId: string,
  owner: string,
): boolean {
  const seen = new Set<string>();
  while (!seen.has(runId)) {
    seen.add(runId);
    const run = ctx.store.getRunSummary(runId);
    if (
      !run ||
      run.ownerNpub !== owner ||
      (run.ownerAlias && run.ownerAlias !== generateIdentityAlias(owner))
    )
      return false;
    const pinned = ctx.store.composition.snapshot(runId)?.definition;
    if (pinned?.scope === "user" && pinned.ownerAlias !== run.ownerAlias)
      return false;
    const parent = ctx.store.composition.parent(runId);
    if (!parent) return true;
    const step = ctx.store
      .listStepSummaries(parent.parentRunId)
      .find((item) => item.id === parent.parentStepId);
    if (
      !step ||
      step.runId !== parent.parentRunId ||
      ctx.store.composition.child(step.id)?.childRunId !== runId
    )
      return false;
    runId = parent.parentRunId;
  }
  return false;
}

function nativeViewerValidChildLinks(
  ctx: Pick<PipelineApiContext, "store">,
  runId: string,
  owner: string,
): boolean {
  for (const step of ctx.store.listStepSummaries(runId)) {
    const link = ctx.store.composition.child(step.id);
    if (!link) continue;
    if (
      link.parentRunId !== runId ||
      link.parentStepId !== step.id ||
      !nativeViewerOwnsRun(ctx, link.childRunId, owner)
    )
      return false;
    const parent = ctx.store.composition.parent(link.childRunId);
    if (
      !parent ||
      parent.parentRunId !== runId ||
      parent.parentStepId !== step.id
    )
      return false;
  }
  return ctx.store.composition
    .children(runId)
    .every(
      (link) =>
        ctx.store
          .listStepSummaries(runId)
          .some((step) => step.id === link.parentStepId) &&
        nativeViewerOwnsRun(ctx, link.childRunId, owner),
    );
}

function pageInteger(
  url: URL,
  key: string,
  fallback: number,
  max: number,
  min = 0,
): number {
  if (!url.searchParams.has(key)) return fallback;
  const raw = url.searchParams.get(key)!;
  const value = Number(raw);
  if (
    url.searchParams.getAll(key).length !== 1 ||
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`invalid-${key}`);
  return value;
}
