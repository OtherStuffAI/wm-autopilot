import { MISSING_PIPELINE_HISTORY_REASON } from "./pipeline-history-resume";
import { handleNativePipelineViewerApi } from "./pipeline-native-viewer-routes";
import { cancelPipelineTree } from "./child-pipeline";
import { rootPipelineRunId, assertPipelineAncestorsRunning } from "./pipeline-run-authority";
import { join } from "node:path";
import { handlePipelineIngress } from "./pipeline-ingress-routes";
import { resumeStoredPipelineRun } from "./stored-run-resume";
export { resumeStoredPipelineRun, resumeStoredErroredPipelineRun, resumeRunningPipelineRuns } from "./stored-run-resume";
import { canAccessPipelineRun, serializeDefinitionSummary, serializeRunSummary, normaliseOptionalString, normalisePositiveInteger, readCancelReason, readAllowedPipelineFunctionSource } from "./pipeline-route-helpers";
import { handlePublicPipelineCall } from "./public-call-routes";
import { publicDelivery, runEnvelope, responseSteps } from "./public-call-contract";
import type { ResultWebhookService } from "./result-webhook-service";
import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import { generateIdentityAlias } from "../identity/identity-alias";
import type { SessionApiContext } from "../server/session-api-routes";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { startPipelineFunctionWizardSession } from "./function-wizard";
import { builtinPipelineFunctions } from "./functions";
import { writeManualDefinitionVersion } from "./definition-editor";
import {
  ensurePipelineDirectories,
  getPipelineDefinition,
  getPipelineRoot,
  getSharedPipelineFunctionsDirectory,
  getUserPipelineDefinitionsDirectory,
  getUserPipelineFunctionsDirectory,
  listLatestPipelineDefinitions,
  listPipelineDefinitions,
  makePipelineSlug,
  nextVersionedDefinitionPath,
  nextVersionedDefinitionPathForSource,
  nextVersionedFunctionPath,
  type PipelineDefinitionRecord,
} from "./pipeline-loader";
import type { FunctionRegistry } from "./declarative";
import { PipelineStore, type PipelineRunRecord } from "./pipeline-store";
import { startPipelineWizardSession } from "./pipeline-wizard";
import { startPipelineAnalysisSession } from "./pipeline-analysis";
import { startFlightDeckPipelineRun } from "./flightdeck-run-service";
import { handleSpaceExplainApi } from "./space-explain-routes";
import type { SpaceExplainService } from "./space-explain-service";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface PipelineApiContext {
  spaceExplainService?: SpaceExplainService;
  store: PipelineStore;
  resultWebhooks?: ResultWebhookService;
  publicWaitClock?: { now: () => number; sleep: (ms: number) => Promise<void> };
  sessionApiContext: SessionApiContext;
  defaultAgent: string;
  callbackOrigin?: string;
  sharedInstanceAccess?: boolean;
  resolveLearningTowerContext?: (input: { authContext: RequestAuthContext; ownerNpub: string }) => { towerUrl: string; workspaceId: string } | null;
  loadRegistryForRun?: (input: {
    run: PipelineRunRecord;
    definition: PipelineDefinitionRecord;
  }) => Promise<FunctionRegistry | null>;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { SessionsManage: AccessAction };
}

export async function handlePipelineApi(
  request: Request, url: URL, method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: PipelineApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;
  const viewer = await handleNativePipelineViewerApi(request, url, authContext, ctx);
  if (viewer) return viewer;
  const explanation = await handleSpaceExplainApi(request, url, authContext, ctx);
  if (explanation) return explanation;

  const ingress = await handlePipelineIngress(request, url, method, authContext, ctx);
  if (ingress) return ingress;

  if (!pathname.startsWith("/api/pipelines")) return null;

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
  if (denied) return denied;

  const ownerNpub = getEffectiveOwnerNpub(authContext);
  if (!ownerNpub) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  const ownerAlias = generateIdentityAlias(ownerNpub);

  if (pathname === "/api/pipelines/root" && method === "GET") {
    return Response.json({
      root: getPipelineRoot(),
      sharedDefinitions: `${getPipelineRoot()}/shared/definitions`,
      sharedFunctions: getSharedPipelineFunctionsDirectory(),
      userDefinitions: `${getPipelineRoot()}/users/${ownerAlias}/definitions`,
      userFunctions: getUserPipelineFunctionsDirectory(ownerAlias),
    });
  }

  if (pathname === "/api/pipelines/functions" && method === "GET") {
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    return Response.json({ functions: functions.records });
  }

  const functionMatch = pathname.match(/^\/api\/pipelines\/functions\/([^/]+)$/);
  if (functionMatch && method === "GET") {
    const name = decodeURIComponent(functionMatch[1]!);
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const record = functions.records.find((entry) => entry.name === name);
    if (!record) return Response.json({ error: "Pipeline function not found" }, { status: 404 });
    const sourcePath = record.path ?? (record.scope === "builtin" ? join(process.cwd(), "src/pipelines/functions.ts") : null);
    const code = sourcePath ? await readAllowedPipelineFunctionSource(sourcePath, ownerAlias, record.scope === "builtin") : null;
    return Response.json({
      function: record,
      sourcePath,
      language: sourcePath?.endsWith(".ts") ? "typescript" : "javascript",
      code,
    });
  }

  if (pathname === "/api/pipelines/functions/wizard" && method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    await ensurePipelineDirectories(ownerAlias);
    const functionsDirectory = getUserPipelineFunctionsDirectory(ownerAlias);
    const targetPath = await nextVersionedFunctionPath(functionsDirectory, makePipelineSlug(prompt));
    const result = await startPipelineFunctionWizardSession({
      sessionApiContext: ctx.sessionApiContext,
      ownerNpub,
      ownerAlias,
      prompt,
      targetPath,
    });
    return Response.json({ ...result, functionsDirectory });
  }

  if (pathname === "/api/pipelines/definitions" && method === "GET") {
    const definitions = await listLatestPipelineDefinitions(ownerAlias);
    return Response.json({
      definitions: definitions.map(serializeDefinitionSummary),
    });
  }

  if (pathname === "/api/pipelines/wizard" && method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    await ensurePipelineDirectories(ownerAlias);
    const definitionsDirectory = getUserPipelineDefinitionsDirectory(ownerAlias);
    const targetPath = await nextVersionedDefinitionPath(definitionsDirectory, makePipelineSlug(prompt));
    const result = await startPipelineWizardSession({
      sessionApiContext: ctx.sessionApiContext,
      ownerNpub,
      ownerAlias,
      prompt,
      targetPath,
      mode: "create",
    });
    return Response.json({ ...result, definitionsDirectory });
  }

  const definitionRunMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/runs$/);
  if (definitionRunMatch && method === "POST") {
    const id = decodeURIComponent(definitionRunMatch[1]!);
    const definition = await getPipelineDefinition(id, ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    return handlePublicPipelineCall(request, url, authContext, ctx, definition, ownerNpub, ownerAlias);
  }

  const flightDeckRunMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/flightdeck-runs$/);
  if (flightDeckRunMatch && method === "POST") {
    const id = decodeURIComponent(flightDeckRunMatch[1]!);
    const definition = await getPipelineDefinition(id, ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    const body = await request.json().catch(() => null);
    try {
      const { input, resolution, run } = await startFlightDeckPipelineRun({ store: ctx.store,
        sessionApiContext: ctx.sessionApiContext, definition, invocation: body as never, ownerNpub, ownerAlias,
        callbackOrigin: ctx.callbackOrigin ?? url.origin });
      return Response.json({
        ok: true,
        invocation: { ...resolution, requesterNpub: input.frmNpub },
        run,
      }, { status: 202 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  const definitionWizardEditMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/wizard-edit$/);
  if (definitionWizardEditMatch && method === "POST") {
    const definition = await getPipelineDefinition(decodeURIComponent(definitionWizardEditMatch[1]!), ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    if (definition.scope !== "user" || definition.ownerAlias !== ownerAlias) {
      return Response.json({ error: "Only user pipeline definitions can be edited by the wizard" }, { status: 403 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Prompt is required" }, { status: 400 });
    const targetPath = await nextVersionedDefinitionPathForSource(definition.path);
    const result = await startPipelineWizardSession({
      sessionApiContext: ctx.sessionApiContext,
      ownerNpub,
      ownerAlias,
      prompt,
      targetPath,
      sourcePath: definition.path,
      mode: "edit",
    });
    return Response.json(result);
  }

  const definitionManualEditMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)\/manual-edit$/);
  if (definitionManualEditMatch && method === "POST") {
    const definition = await getPipelineDefinition(decodeURIComponent(definitionManualEditMatch[1]!), ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    if (definition.scope !== "user" || definition.ownerAlias !== ownerAlias) {
      return Response.json({ error: "Only user pipeline definitions can be manually edited" }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Manual edit body must be a JSON object" }, { status: 400 });
    }
    try {
      const result = await writeManualDefinitionVersion(definition, body as Record<string, unknown>);
      const definitions = await listPipelineDefinitions(ownerAlias);
      const nextDefinition = definitions.find((entry) => entry.path === result.targetPath);
      return Response.json({
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        definition: nextDefinition ? serializeDefinitionSummary(nextDefinition) : null,
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 400 });
    }
  }

  const definitionMatch = pathname.match(/^\/api\/pipelines\/definitions\/([^/]+)$/);
  if (definitionMatch && method === "GET") {
    const definition = await getPipelineDefinition(decodeURIComponent(definitionMatch[1]!), ownerAlias);
    if (!definition) return Response.json({ error: "Pipeline definition not found" }, { status: 404 });
    return Response.json({ definition });
  }

  if (pathname === "/api/pipelines/runs" && method === "GET") {
    const runs = ctx.store.listRunSummaries({
      ownerNpub,
      includeShared: Boolean(ctx.sharedInstanceAccess),
    });
    const includeDefinitionMeta = url.searchParams.get("includeDefinitionMeta") !== "0";
    const definitions = includeDefinitionMeta ? await listLatestPipelineDefinitions(ownerAlias) : [];
    return Response.json({ runs: runs.filter(run => canAccessPipelineRun(run, ownerNpub, ctx)).map((run) => serializeRunSummary(run, definitions)) });
  }

  if (pathname === "/api/pipelines/runs/compact-completed" && method === "POST") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = ctx.store.compactCompletedRunPayloads({
      ownerNpub,
      includeShared: Boolean(ctx.sharedInstanceAccess),
      definitionId: normaliseOptionalString(body.definitionId),
      runName: normaliseOptionalString(body.name ?? body.runName),
      includeErrored: body.includeErrored === true,
      olderThan: normaliseOptionalString(body.olderThan),
      limit: normalisePositiveInteger(body.limit),
      dryRun: body.dryRun === true,
    });
    return Response.json({ ok: true, ...result, dryRun: body.dryRun === true });
  }

  const runResumeMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/resume-from-failure$/);
  if (runResumeMatch && method === "POST") {
    const id = decodeURIComponent(runResumeMatch[1]!);
    const run = ctx.store.getRun(id);
    if (!run || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    if (run.status !== "error") {
      return Response.json({ error: "Only errored pipeline runs can be resumed from failure", run }, { status: 409 });
    }
    if (!ctx.store.composition.snapshot(id)) return Response.json({ error: MISSING_PIPELINE_HISTORY_REASON }, { status: 409 });
    try { assertPipelineAncestorsRunning(ctx.store, id); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    const reopened = ctx.store.reopenErroredRun(id);
    if (!reopened || reopened.status !== "running") {
      return Response.json({ error: "Pipeline run could not be reopened", run: reopened }, { status: 409 });
    }
    void resumeStoredPipelineRun(ctx, id, ctx.callbackOrigin ?? url.origin).catch((error) => {
      ctx.store.addEvent({
        runId: id,
        level: "error",
        type: "run_resume_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    const summary = ctx.store.getRunSummary(id);
    const definitions = await listLatestPipelineDefinitions(ownerAlias);
    return Response.json({
      ok: true,
      run: summary ? serializeRunSummary(summary, definitions) : reopened,
      steps: responseSteps(ctx.store, id),
    }, { status: 202 });
  }

  const runCancelMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/cancel$/);
  if (runCancelMatch && method === "POST") {
    const id = decodeURIComponent(runCancelMatch[1]!);
    const run = ctx.store.getRun(id);
    if (!run || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    if (run.status !== "running") {
      return Response.json({ error: "Only running pipeline runs can be stopped", run }, { status: 409 });
    }
    const reason = readCancelReason(await request.json().catch(() => null));
    await cancelPipelineTree(ctx.store, ctx.sessionApiContext, id, reason);
    const cancelled = ctx.store.getRun(id);
    const summary = ctx.store.getRunSummary(id);
    const definitions = await listLatestPipelineDefinitions(ownerAlias);
    return Response.json({
      ok: true,
      run: summary ? serializeRunSummary(summary, definitions) : cancelled,
      steps: responseSteps(ctx.store, id),
    });
  }

  const runAnalysisMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/analysis-sessions$/);
  if (runAnalysisMatch && method === "POST") {
    const id = decodeURIComponent(runAnalysisMatch[1]!);
    const run = ctx.store.getRun(id);
    if (!run || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    const agent = ctx.defaultAgent;
    if (!ctx.sessionApiContext.isAgentType(agent)) {
      return Response.json({ error: `Default agent is not configured for pipeline analysis: ${agent}` }, { status: 500 });
    }
    const definition = await getPipelineDefinition(run.definitionId, ownerAlias);
    const result = await startPipelineAnalysisSession({
      sessionApiContext: ctx.sessionApiContext,
      agent,
      ownerNpub,
      run,
      definition,
      steps: ctx.store.listStepSummaries(run.id),
      callbackOrigin: ctx.callbackOrigin ?? url.origin,
    });
    return Response.json(result, { status: 201 });
  }

  const runStepsMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps$/);
  if (runStepsMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(runStepsMatch[1]!));
    if (!run || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    const includePayload = url.searchParams.get("includePayload") === "1";
    return Response.json({ steps: responseSteps(ctx.store, run.id, includePayload) });
  }

  const stepMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps\/([^/]+)$/);
  if (stepMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(stepMatch[1]!));
    const step = ctx.store.getStep(decodeURIComponent(stepMatch[2]!));
    if (!run || !step || step.runId !== run.id || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline step not found" }, { status: 404 });
    }
    return Response.json({
      step: ctx.store.publicCalls.isPublic(rootPipelineRunId(ctx.store, run.id)) ? { ...step, callbackToken: null } : step,
      events: ctx.store.listEventsForStep(step.id),
      callbacks: ctx.store.publicCalls.isPublic(rootPipelineRunId(ctx.store, run.id)) ? [] : ctx.store.listCallbacksForStep(step.id),
      previousSteps: ctx.store.listStepSummaries(run.id).filter((entry) => entry.stepIndex < step.stepIndex),
    });
  }

  if (pathname === "/api/pipelines/webhook-signer" && method === "GET") {
    return Response.json({ pubkey: ctx.resultWebhooks?.pubkey ?? null, scheme: "NIP-98" });
  }

  const deliveryMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/delivery$/);
  if (deliveryMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(deliveryMatch[1]!));
    if (!run || run.ownerNpub !== ownerNpub) return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    return Response.json({ ...runEnvelope(run), delivery: publicDelivery(ctx.store.publicCalls.getDelivery(run.id)) },
      { headers: { "Cache-Control": "no-store" } });
  }

  const runMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const id = decodeURIComponent(runMatch[1]!);
    const includeRunPayload = url.searchParams.get("includeRunPayload") === "1" || url.searchParams.get("includePayload") === "1";
    const run = includeRunPayload ? ctx.store.getRun(id) : ctx.store.getRunSummary(id);
    if (!run || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    const includePayload = url.searchParams.get("includePayload") === "1";
    const fullRun = ctx.store.getRun(id)!;
    return Response.json({ ...runEnvelope(fullRun), run,
      composition: {
        parent: ctx.store.composition.parent(id),
        children: ctx.store.composition.children(id),
        definitionHash: ctx.store.composition.snapshot(id)?.hash ?? null,
        definitionVersion: ctx.store.composition.snapshot(id)?.definition.spec.version ?? null,
      },
      steps: responseSteps(ctx.store, run.id, includePayload),
    }, { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
