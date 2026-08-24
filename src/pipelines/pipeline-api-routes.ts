import { readFile, realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";
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
import {
  acceptAgentCallback,
  resumeDeclarativePipeline,
  resumeErroredDeclarativePipeline,
  runDeclarativePipeline,
  startDeclarativePipeline,
} from "./pipeline-runner";
import type { FunctionRegistry } from "./declarative";
import { type JsonObject, PipelineStore, type PipelineRunRecord, type PipelineRunSummary } from "./pipeline-store";
import { startPipelineWizardSession } from "./pipeline-wizard";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface PipelineApiContext {
  store: PipelineStore;
  sessionApiContext: SessionApiContext;
  callbackOrigin?: string;
  sharedInstanceAccess?: boolean;
  loadRegistryForRun?: (input: {
    run: PipelineRunRecord;
    definition: PipelineDefinitionRecord;
  }) => Promise<FunctionRegistry | null>;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { SessionsManage: AccessAction };
}

export async function handlePipelineApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: PipelineApiContext,
): Promise<Response | null> {
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
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const submittedInput = body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? body.input as JsonObject
      : {};
    const input = { ...(definition.spec.input ?? {}), ...submittedInput };
    const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
    const runnerInput = {
      store: ctx.store,
      sessionApiContext: ctx.sessionApiContext,
      definition,
      registry: functions.registry,
      input,
      ownerNpub,
      ownerAlias,
      callbackOrigin: ctx.callbackOrigin ?? url.origin,
    };
    if (url.searchParams.get("async") === "1") {
      const run = startDeclarativePipeline(runnerInput);
      return Response.json({ run, steps: [] }, { status: 202 });
    }
    const run = await runDeclarativePipeline(runnerInput);
    return Response.json({ run, steps: ctx.store.listSteps(run.id) });
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
    return Response.json({ runs: runs.map((run) => serializeRunSummary(run, definitions)) });
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
      steps: ctx.store.listStepSummaries(id),
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
    const runningSteps = ctx.store.listSteps(id).filter((step) => step.status === "running" || step.status === "queued");
    const reason = readCancelReason(await request.json().catch(() => null));
    const cancelled = ctx.store.cancelRun(id, reason);
    await stopPipelineStepSessions(ctx, runningSteps.map((step) => step.wingmanSessionId));
    const summary = ctx.store.getRunSummary(id);
    const definitions = await listLatestPipelineDefinitions(ownerAlias);
    return Response.json({
      ok: true,
      run: summary ? serializeRunSummary(summary, definitions) : cancelled,
      steps: ctx.store.listStepSummaries(id),
    });
  }

  const runStepsMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps$/);
  if (runStepsMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(runStepsMatch[1]!));
    if (!run || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline run not found" }, { status: 404 });
    }
    const includePayload = url.searchParams.get("includePayload") === "1";
    return Response.json({ steps: includePayload ? ctx.store.listSteps(run.id) : ctx.store.listStepSummaries(run.id) });
  }

  const stepMatch = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)\/steps\/([^/]+)$/);
  if (stepMatch && method === "GET") {
    const run = ctx.store.getRun(decodeURIComponent(stepMatch[1]!));
    const step = ctx.store.getStep(decodeURIComponent(stepMatch[2]!));
    if (!run || !step || step.runId !== run.id || !canAccessPipelineRun(run, ownerNpub, ctx)) {
      return Response.json({ error: "Pipeline step not found" }, { status: 404 });
    }
    return Response.json({
      step,
      events: ctx.store.listEventsForStep(step.id),
      callbacks: ctx.store.listCallbacksForStep(step.id),
      previousSteps: ctx.store.listStepSummaries(run.id).filter((entry) => entry.stepIndex < step.stepIndex),
    });
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
    return Response.json({ run, steps: includePayload ? ctx.store.listSteps(run.id) : ctx.store.listStepSummaries(run.id) });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function resumeStoredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<void> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "running") return;
  const ownerAlias = run.ownerAlias;
  const definition = await getPipelineDefinition(run.definitionId, ownerAlias);
  if (!definition) {
    ctx.store.completeRun(run.id, "error", run.current, `Pipeline definition not found: ${run.definitionId}`);
    return;
  }
  const registry = await ctx.loadRegistryForRun?.({ run, definition })
    ?? (await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions)).registry;
  await resumeDeclarativePipeline({
    store: ctx.store,
    sessionApiContext: ctx.sessionApiContext,
    definition,
    registry,
    input: run.input,
    ownerNpub: run.ownerNpub,
    ownerAlias,
    callbackOrigin,
  }, run.id);
}

export async function resumeStoredErroredPipelineRun(
  ctx: PipelineApiContext,
  runId: string,
  callbackOrigin: string,
): Promise<PipelineRunRecord | null> {
  const run = ctx.store.getRun(runId);
  if (!run || run.status !== "error") return run;
  const ownerAlias = run.ownerAlias;
  const definition = await getPipelineDefinition(run.definitionId, ownerAlias);
  if (!definition) {
    const reopened = ctx.store.reopenErroredRun(run.id);
    if (!reopened || reopened.status !== "running") return reopened;
    return ctx.store.completeRun(run.id, "error", run.current, `Pipeline definition not found: ${run.definitionId}`);
  }
  const registry = await ctx.loadRegistryForRun?.({ run, definition })
    ?? (await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions)).registry;
  return await resumeErroredDeclarativePipeline({
    store: ctx.store,
    sessionApiContext: ctx.sessionApiContext,
    definition,
    registry,
    input: run.input,
    ownerNpub: run.ownerNpub,
    ownerAlias,
    callbackOrigin,
  }, run.id);
}

export async function resumeRunningPipelineRuns(
  ctx: PipelineApiContext,
  callbackOrigin: string,
): Promise<void> {
  for (const run of ctx.store.listRunningRuns()) {
    await resumeStoredPipelineRun(ctx, run.id, callbackOrigin);
  }
}

function isHttpPipelineTriggerTokenAuthorized(request: Request): boolean {
  const configured = process.env.WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN?.trim();
  if (!configured) return process.env.WINGMEN_PIPELINE_HTTP_TRIGGER_ALLOW_UNAUTH === "1";
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerToken = request.headers.get("x-wingmen-pipeline-trigger-token")?.trim();
  return bearer === configured || headerToken === configured;
}

async function getHttpTriggerPipelineDefinition(key: string, ownerAlias: string | null): Promise<PipelineDefinitionRecord | null> {
  const definitions = await listPipelineDefinitions(ownerAlias);
  return definitions.find((definition) =>
    definition.id === key ||
    definition.slug === key ||
    definition.name === key ||
    definition.spec.name === key
  ) ?? null;
}

function normaliseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalisePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readCancelReason(payload: unknown): string {
  const reason = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).reason
    : null;
  return typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "Pipeline run stopped by user";
}

async function stopPipelineStepSessions(ctx: PipelineApiContext, sessionIds: Array<string | null>): Promise<void> {
  const uniqueIds = [...new Set(sessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  await Promise.all(uniqueIds.map(async (sessionId) => {
    const stopped = await ctx.sessionApiContext.manager.stopSession(sessionId).catch(() => false);
    if (stopped) {
      ctx.sessionApiContext.scheduleSessionArchive(sessionId, ctx.sessionApiContext.manager);
    }
  }));
}

function serializeDefinitionSummary(definition: PipelineDefinitionRecord): JsonObject {
  return {
    id: definition.id,
    slug: definition.slug,
    name: definition.name,
    description: typeof definition.spec.description === "string" ? definition.spec.description : "",
    version: definition.spec.version ?? null,
    supersedes: typeof definition.spec.supersedes === "string" ? definition.spec.supersedes : null,
    default: definition.spec.default === true,
    tags: normalizeTags(definition.spec.tags),
    scope: definition.scope,
    ownerAlias: definition.ownerAlias,
    path: definition.path,
    input: definition.spec.input ?? {},
    steps: definition.spec.steps,
  };
}

function canAccessPipelineRun(
  run: Pick<PipelineRunRecord | PipelineRunSummary, "ownerNpub" | "scope">,
  ownerNpub: string,
  ctx: PipelineApiContext,
): boolean {
  if (run.ownerNpub === ownerNpub) return true;
  return Boolean(ctx.sharedInstanceAccess && run.scope === "shared");
}

function serializeRunSummary(
  run: PipelineRunSummary,
  definitions: PipelineDefinitionRecord[],
): JsonObject {
  const definition = definitions.find((entry) => (
    entry.id === run.definitionId
    || entry.slug === run.definitionId
    || entry.name === run.definitionId
    || entry.path === run.definitionPath
    || pipelineSupersedes(entry, run.definitionId)
  ));
  return {
    ...run,
    definitionSlug: definition?.slug ?? fallbackDefinitionSlug(run),
    definitionDefault: definition?.spec.default === true,
    tags: definition ? normalizeTags(definition.spec.tags) : [],
  };
}

function pipelineSupersedes(definition: PipelineDefinitionRecord, id: string): boolean {
  return typeof definition.spec.supersedes === "string" && definition.spec.supersedes === id;
}

function fallbackDefinitionSlug(run: PipelineRunSummary): string | null {
  const fromPath = typeof run.definitionPath === "string" && run.definitionPath.trim()
    ? basename(run.definitionPath.trim(), ".json")
    : "";
  if (fromPath) return fromPath;
  const definitionId = typeof run.definitionId === "string" ? run.definitionId.trim() : "";
  return definitionId || null;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "")
    .filter(Boolean))]
    .sort();
}

async function readAllowedPipelineFunctionSource(path: string, ownerAlias: string, allowBuiltin: boolean): Promise<string> {
  const allowedRoots = [
    getSharedPipelineFunctionsDirectory(),
    getUserPipelineFunctionsDirectory(ownerAlias),
  ];
  if (allowBuiltin) {
    allowedRoots.push(join(process.cwd(), "src/pipelines"));
  }
  const realPath = await realpath(path);
  const realRoots = await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => null)));
  const allowed = realRoots.some((root) => root && (realPath === root || realPath.startsWith(`${root}${sep}`)));
  if (!allowed) {
    throw new Error("Pipeline function source path is outside allowed roots");
  }
  return readFile(realPath, "utf8");
}
