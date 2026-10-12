import { rootPipelineRunId } from "./pipeline-run-authority";
import { readFile, realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import type { PipelineApiContext } from "./pipeline-api-routes";
import { getSharedPipelineFunctionsDirectory, getUserPipelineFunctionsDirectory, listPipelineDefinitions, type PipelineDefinitionRecord } from "./pipeline-loader";
import type { JsonObject, PipelineRunRecord, PipelineRunSummary } from "./pipeline-store";

export function isHttpPipelineTriggerTokenAuthorized(request: Request): boolean {
  const configured = process.env.WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN?.trim();
  if (!configured) return process.env.WINGMEN_PIPELINE_HTTP_TRIGGER_ALLOW_UNAUTH === "1";
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerToken = request.headers.get("x-wingmen-pipeline-trigger-token")?.trim();
  return bearer === configured || headerToken === configured;
}

export async function getHttpTriggerPipelineDefinition(key: string, ownerAlias: string | null): Promise<PipelineDefinitionRecord | null> {
  const definitions = await listPipelineDefinitions(ownerAlias);
  return definitions.find((definition) =>
    definition.id === key ||
    definition.slug === key ||
    definition.name === key ||
    definition.spec.name === key
  ) ?? null;
}

export function normaliseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalisePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function readCancelReason(payload: unknown): string {
  const reason = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).reason
    : null;
  return typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "Pipeline run stopped by user";
}

export async function stopPipelineStepSessions(ctx: PipelineApiContext, sessionIds: Array<string | null>): Promise<void> {
  const uniqueIds = [...new Set(sessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  await Promise.all(uniqueIds.map(async (sessionId) => {
    const stopped = await ctx.sessionApiContext.manager.stopSession(sessionId).catch(() => false);
    if (stopped) {
      ctx.sessionApiContext.scheduleSessionArchive(sessionId, ctx.sessionApiContext.manager);
    }
  }));
}

export function serializeDefinitionSummary(definition: PipelineDefinitionRecord): JsonObject {
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

export function canAccessPipelineRun(
  run: Pick<PipelineRunRecord | PipelineRunSummary, "id" | "ownerNpub" | "scope" | "name">,
  ownerNpub: string,
  ctx: PipelineApiContext,
): boolean {
  const rootId = rootPipelineRunId(ctx.store, run.id);
  if (rootId !== run.id) {
    const root = ctx.store.getRun(rootId);
    return Boolean(root && canAccessPipelineRun(root, ownerNpub, ctx));
  }
  if (run.ownerNpub === ownerNpub) return true;
  if (run.ownerNpub && ctx.installedAppExecutionNpubs?.(ownerNpub).includes(run.ownerNpub)) return true;
  if (ctx.store.publicCalls.isPublic(run.id)) return false;
  if (/^learning-(plan|question|lesson|assessment|recall)$/.test(run.name)) return false;
  return Boolean(ctx.sharedInstanceAccess && run.scope === "shared");
}

export function serializeRunSummary(
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

export async function readAllowedPipelineFunctionSource(path: string, ownerAlias: string, allowBuiltin: boolean): Promise<string> {
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
