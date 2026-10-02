import { DelegationScopes, resolveOwnerAccess } from "../auth/delegation-access";
import type { RequestAuthContext } from "../auth/request-context";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { installationIdForIdentity } from "../control-plane/connect-package";
import type { ControlPlaneRoutesContext } from "../server/control-plane-routes";
import type { PipelineStore } from "./pipeline-store";
import { viewerCanReadRun, viewerGrantMatches, type ViewerContext } from "./pipeline-viewer-access";
import { viewerDefinition, viewerRunSummary, viewerSnapshot } from "./pipeline-viewer-dto";

export interface PipelineViewerRoutesContext {
  identity: WingmanInstanceIdentity | null;
  store: PipelineStore;
  workspaceDelegationStore: ControlPlaneRoutesContext["workspaceDelegationStore"];
  agentStore: ControlPlaneRoutesContext["agentStore"];
  pipelineBindingStore: ControlPlaneRoutesContext["pipelineBindingStore"];
  listPipelineDefinitions: ControlPlaneRoutesContext["listPipelineDefinitions"];
}

export async function handlePipelineViewerApi(request: Request, url: URL, auth: RequestAuthContext,
  ctx: PipelineViewerRoutesContext): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/pipeline-viewer(?:\/(.*))?$/);
  if (!match) return null;
  const serviceId = ctx.identity ? installationIdForIdentity(ctx.identity) : null;
  const reply = (body: Record<string, unknown>, status = 200) => Response.json(ctx.store.evidence.sanitize({ version: 1, serviceId, ...body }).value,
    { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET") return reply({ error: "method-not-allowed" }, 405);
  if (auth.authMethod !== "nip98") return reply({ error: "control-plane-read-authority-required" }, 403);
  if (!ctx.identity || !serviceId) return reply({ error: "installation-identity-unavailable" }, 503);
  let owner: string;
  try { owner = decodeURIComponent(match[1]!); } catch { return reply({ error: "invalid-owner" }, 400); }
  const access = resolveOwnerAccess(auth, owner, ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore), DelegationScopes.ControlPlaneRead);
  if (!access) return reply({ error: "control-plane-read-authority-required" }, 403);
  try {
    const context: ViewerContext = {
      workspaceId: required(url, "workspace_id"), towerServiceNpub: required(url, "tower_service_npub"), appNpub: required(url, "app_npub"),
    };
    const resource = (match[2] ?? "").split("/").map(decodeURIComponent);
    const canRead = (runId: string) => viewerCanReadRun(ctx.store, runId, access, context, {
      canReadAgent: (id, npub) => {
        const agent = ctx.agentStore.getByAgentId(id);
        return Boolean(agent && agent.managedByNpub === access.ownerNpub && agent.botNpub === npub
          && agent.enabled && !agent.archived && (access.selfAccess || ctx.agentStore.canInstruct(id, access.subjectNpub)));
      },
    });
    if (resource[0] === "definitions") {
      const filters = access.delegation?.resourceFilters;
      // Scope is resolved from durable Tower invocation context, never a caller scope query.
      const scopeAllowed = !filters?.scopeIds?.length || hasAuthorizedScopeRun(ctx.store, access.ownerNpub, canRead);
      const contextAllowed = viewerGrantMatches({ workspaceIds: filters?.workspaceIds }, { workspaceId: context.workspaceId }) && scopeAllowed;
      const allowedAgentIds = access.delegation?.resourceFilters?.agentIds;
      const boundIds = allowedAgentIds?.length ? new Set(allowedAgentIds.flatMap(id => {
        const agent = ctx.agentStore.getByAgentId(id);
        if (!agent || agent.managedByNpub !== access.ownerNpub || !agent.enabled || agent.archived || !ctx.agentStore.canInstruct(id, access.subjectNpub)) return [];
        return ctx.pipelineBindingStore.listAvailableIds(id);
      })) : null;
      const definitions = (await ctx.listPipelineDefinitions(access.ownerNpub))
        .filter(definition => contextAllowed && (!boundIds || boundIds.has(definition.id))).sort((a, b) => a.id.localeCompare(b.id));
      if (resource.length === 2) {
        const definition = definitions.find(item => item.id === resource[1]);
        return definition ? reply({ definition: viewerDefinition(definition, undefined, undefined, ctx.store.evidence.sanitize.bind(ctx.store.evidence)) }) : reply({ error: "not-found" }, 404);
      }
      if (resource.length !== 1) return reply({ error: "not-found" }, 404);
      const limit = integer(url, "limit", 50, 1, 100);
      const cursor = cursorValue(url, "definitions");
      const start = cursor ? definitions.findIndex(item => item.id === cursor.id) + 1 : 0;
      if (cursor && start === 0) throw new Error("invalid-cursor");
      const page = definitions.slice(start, start + limit);
      return reply({ definitions: page.map(item => viewerDefinition(item, undefined, undefined, ctx.store.evidence.sanitize.bind(ctx.store.evidence))), nextCursor: start + limit < definitions.length
        ? encodeCursor({ collection: "definitions", id: page.at(-1)!.id }) : null });
    }
    if (resource[0] !== "runs") return reply({ error: "not-found" }, 404);
    if (resource.length === 1) {
      const limit = integer(url, "limit", 50, 1, 100);
      const cursor = cursorValue(url, "runs");
      if (cursor && typeof cursor.startedAt !== "string") throw new Error("invalid-cursor");
      let before = cursor ? { id: cursor.id, startedAt: cursor.startedAt! } : null;
      const selected = [];
      const definitionId = url.searchParams.get("definitionId");
      // Scan past denied records until a full authorized page is found, without a first-N cap.
      while (selected.length <= limit) {
        const batch = ctx.store.pageOwnerRuns(access.ownerNpub, before, 100);
        if (!batch.length) break;
        for (const run of batch) {
          if ((!definitionId || run.definitionId === definitionId) && canRead(run.id)) selected.push(run);
          if (selected.length > limit) break;
        }
        const last = batch.at(-1)!;
        before = { id: last.id, startedAt: last.startedAt };
        if (batch.length < 100) break;
      }
      const page = selected.slice(0, limit);
      return reply({ runs: page.map(run => viewerRunSummary(run, ctx.store, serviceId)), nextCursor: selected.length > limit
        ? encodeCursor({ collection: "runs", id: page.at(-1)!.id, startedAt: page.at(-1)!.startedAt }) : null });
    }
    const runId = resource[1]!;
    if (!canRead(runId)) return reply({ error: "not-found" }, 404);
    if (resource.length === 4 && resource[2] === "evidence") {
      const offset = integer(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(url, "limit", 100, 1, 500);
      const record = ctx.store.evidence.get(runId, resource[3]!);
      if (!record) return reply({ error: "not-found" }, 404);
      if (!Array.isArray(record.value)) {
        if (offset !== 0) throw new Error("offset-only-for-array");
        return reply({ ...record, nextOffset: null });
      }
      return reply({ evidence: record.evidence, value: record.value.slice(offset, offset + limit),
        nextOffset: offset + limit < record.value.length ? offset + limit : null });
    }
    if (resource.length !== 2 && !(resource.length === 3 && resource[2] === "updates")) return reply({ error: "not-found" }, 404);
    const snapshot = ctx.store.composition.transaction(() => viewerSnapshot(runId, ctx.store, serviceId));
    const unchanged = resource[2] === "updates" && url.searchParams.get("after") === snapshot.revision;
    return reply({ ...snapshot, ...(resource[2] === "updates" ? { unchanged } : {}) });
  } catch (error) {
    if (error instanceof URIError || error instanceof Error && /^(invalid-|missing-|offset-only)/.test(error.message)) {
      return reply({ error: error instanceof Error ? error.message : "invalid-request" }, 400);
    }
    throw error;
  }
}

function required(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value?.trim()) throw new Error(`missing-${key}`);
  if (url.searchParams.getAll(key).length !== 1) throw new Error(`invalid-${key}`);
  return value;
}
function integer(url: URL, key: string, fallback: number, min: number, max: number): number {
  if (!url.searchParams.has(key)) return fallback;
  const raw = required(url, key);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid-${key}`);
  return value;
}
function encodeCursor(value: { collection: string; id: string; startedAt?: string }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function cursorValue(url: URL, collection: string): { id: string; startedAt?: string } | null {
  if (!url.searchParams.get("cursor")) return null;
  try {
    const raw = required(url, "cursor");
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (value.collection !== collection || typeof value.id !== "string" || !value.id || value.startedAt !== undefined && !Number.isFinite(Date.parse(value.startedAt))) throw new Error();
    return value;
  } catch { throw new Error("invalid-cursor"); }
}

function hasAuthorizedScopeRun(store: PipelineStore, owner: string, canRead: (id: string) => boolean): boolean {
  let before: { id: string; startedAt: string } | null = null;
  while (true) {
    const runs = store.pageOwnerRuns(owner, before, 100);
    if (runs.some(run => canRead(run.id))) return true;
    if (runs.length < 100) return false;
    const last = runs.at(-1)!;
    before = { id: last.id, startedAt: last.startedAt };
  }
}
