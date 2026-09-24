import type { AgentDefinitionRecord } from "../agent-chat/types";
import { DelegationScopes, resolveOwnerAccess } from "../auth/delegation-access";
import type { RequestAuthContext } from "../auth/request-context";
import {
  CONTROL_API_VERSION,
  createAutopilotConnectPackage,
  createAutopilotConnectPackageV2,
  installationIdForIdentity,
} from "../control-plane/connect-package";
import type {
  AgentDiscoveryItemV1,
  AgentDiscoveryV1,
  AgentOverviewV1,
  AgentPipelinesV1,
  AgentSchedulesV1,
  AgentTriggersV1,
  InstallationHealthV1,
  PipelineDefinitionSummaryV1,
} from "../control-plane/contracts";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { normaliseNpub } from "../identity/npub-utils";
import type { PipelineBindingStore } from "../pipelines/pipeline-binding-store";
import type { PipelineDefinitionRecord } from "../pipelines/pipeline-loader";
import type { ScheduledJob, SchedulerStore } from "../scheduler/scheduler-store";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import type { FipsAppEndpoint } from "../apps/fips-app-ingress-manager";
import { nip19 } from "nostr-tools";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

interface AgentStore {
  listForManagerNpub(npub: string): AgentDefinitionRecord[];
  getByAgentId(agentId: string): AgentDefinitionRecord | null;
  canInstruct(agentId: string, authorNpub: string | null | undefined): boolean;
}

export interface ControlPlaneRoutesContext {
  identity: WingmanInstanceIdentity | null;
  baseUrl: string;
  baseUrlConfigured: boolean;
  getFipsEndpoint: () => FipsAppEndpoint;
  workspaceDelegationStore: WorkspaceDelegationStore;
  agentStore: AgentStore;
  pipelineBindingStore: Pick<PipelineBindingStore, "getAvailabilityMode" | "getDefaultMode" | "listAvailableIds" | "listDefaultIds" | "listOverrides">;
  listPipelineDefinitions: (ownerNpub: string) => Promise<PipelineDefinitionRecord[]>;
  schedulerStore: Pick<SchedulerStore, "bindLegacyJobsToAgent" | "listJobsForAgent">;
  now?: () => Date;
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function validNpub(value: string): string | null {
  const normalized = normaliseNpub(value);
  if (!normalized) return null;
  try {
    const decoded = nip19.decode(normalized);
    return decoded.type === "npub" && typeof decoded.data === "string" ? normalized : null;
  } catch {
    return null;
  }
}

function readyInstallation(ctx: ControlPlaneRoutesContext): { identity: WingmanInstanceIdentity; fips: FipsAppEndpoint } | Response {
  if (!ctx.identity) return Response.json({ error: "installation-identity-unavailable" }, { status: 503 });
  const fips = ctx.getFipsEndpoint();
  if (fips.status !== "listening" || !fips.url) {
    return Response.json({
      error: "fips-transport-unavailable",
      status: fips.status,
      detail: fips.error ?? "The approved FIPS endpoint is not listening",
    }, { status: 503 });
  }
  return { identity: ctx.identity, fips };
}

function readyLegacyInstallation(ctx: ControlPlaneRoutesContext): { identity: WingmanInstanceIdentity; fips: FipsAppEndpoint } | Response {
  const installation = readyInstallation(ctx);
  if (installation instanceof Response) return installation;
  if (installation.fips.nodeNpub !== installation.identity.npub) {
    return Response.json({
      error: "fips-identity-mismatch",
      detail: "Connect package v1 requires the FIPS transport identity to equal the Autopilot installation signer; use v2 for distinct identities",
      upgrade_path: "/api/control-plane/v2/connect-package",
    }, { status: 503 });
  }
  return installation;
}

function agentPaths(ownerNpub: string, agentId: string): AgentDiscoveryItemV1["paths"] {
  const base = `/api/owners/${encodeURIComponent(ownerNpub)}/control-plane/v1/agents/${encodeURIComponent(agentId)}`;
  return { overview: `${base}/overview`, pipelines: `${base}/pipelines`, schedules: `${base}/schedules`, triggers: `${base}/triggers` };
}

function discovery(agent: AgentDefinitionRecord, signerNpub: string, ownerNpub: string): AgentDiscoveryItemV1 {
  return {
    agent_id: agent.agentId,
    bot_npub: agent.botNpub,
    name: agent.publicProfile?.name || agent.label || agent.agentId,
    description: agent.publicProfile?.about ?? "",
    can_instruct: agent.instructorNpubs?.includes(signerNpub) ?? false,
    paths: agentPaths(ownerNpub, agent.agentId),
  };
}

function overview(installationId: string, agent: AgentDefinitionRecord, signerNpub: string, ownerNpub: string): AgentOverviewV1 {
  return {
    installation_id: installationId,
    agent: {
      ...discovery(agent, signerNpub, ownerNpub),
      picture: agent.publicProfile?.picture ?? null,
      nip05: agent.publicProfile?.nip05 ?? null,
      capabilities: [...agent.capabilities],
      enabled: agent.enabled,
      archived: agent.archived === true,
    },
  };
}

type AgentResource = "overview" | "pipelines" | "schedules" | "triggers";

function ownerRoute(pathname: string): { ownerNpub: string; resource: string; agentId: string | null; agentResource: AgentResource | null } | null {
  const match = pathname.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/(manifest|health|agents)(?:\/([^/]+))?(?:\/(overview|pipelines|schedules|triggers))?$/);
  if (!match) return null;
  let ownerNpub: string | null;
  try {
    ownerNpub = validNpub(decodeURIComponent(match[1]!));
  } catch {
    return null;
  }
  if (!ownerNpub) return null;
  return {
    ownerNpub,
    resource: match[2]!,
    agentId: match[3] ? decodeURIComponent(match[3]) : null,
    agentResource: (match[4] as AgentResource | undefined) ?? null,
  };
}

function definitionSummary(definition: PipelineDefinitionRecord): PipelineDefinitionSummaryV1 {
  return {
    pipeline_definition_id: definition.id,
    name: definition.name,
    description: definition.spec.description ?? "",
    scope: definition.scope,
    version: definition.spec.version ?? null,
    tags: [...(definition.spec.tags ?? [])],
  };
}

function scheduleItem(job: ScheduledJob, agent: AgentDefinitionRecord) {
  return {
    schedule_id: job.id,
    agent_id: agent.agentId,
    bot_npub: job.botNpub,
    name: job.name,
    enabled: job.enabled,
    cron_expression: job.cronExpression,
    timezone: job.timezone,
    active_start_time: job.activeStartTime,
    active_end_time: job.activeEndTime,
    action_type: job.actionType,
    pipeline_definition_id: job.pipelineDefinitionId,
    last_run_at: job.lastRunAt,
    next_run_at: job.nextRunAt,
  };
}

function triggerItem(job: ScheduledJob, agent: AgentDefinitionRecord) {
  return {
    trigger_id: job.id,
    agent_id: agent.agentId,
    bot_npub: job.botNpub,
    name: job.name,
    enabled: job.enabled,
    trigger_type: job.triggerType === "cron" ? "unsupported" as const : job.triggerType,
    file_pattern: job.filePattern,
    action_type: job.actionType,
    pipeline_definition_id: job.pipelineDefinitionId,
    last_run_at: job.lastRunAt,
  };
}

function authorisedAgents(
  route: { ownerNpub: string },
  authContext: RequestAuthContext,
  ctx: ControlPlaneRoutesContext,
): { agents: AgentDefinitionRecord[]; signerNpub: string } | Response {
  const access = resolveOwnerAccess(
    authContext,
    route.ownerNpub,
    ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
    DelegationScopes.ControlPlaneRead,
  );
  if (!access) return Response.json({ error: "control-plane-read-authority-required", requiredScope: DelegationScopes.ControlPlaneRead }, { status: 403 });
  const allowedIds = access.delegation?.resourceFilters?.agentIds;
  const agents = ctx.agentStore.listForManagerNpub(route.ownerNpub).filter((agent) => {
    if (!agent.enabled || agent.archived === true) return false;
    if (allowedIds?.length && !allowedIds.includes(agent.agentId)) return false;
    return access.selfAccess || ctx.agentStore.canInstruct(agent.agentId, access.subjectNpub);
  });
  return { agents, signerNpub: access.subjectNpub };
}

export async function handleControlPlaneApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: ControlPlaneRoutesContext,
): Promise<Response | null> {
  if (url.pathname === "/api/control-plane/v1/connect-package" || url.pathname === "/api/control-plane/v2/connect-package") {
    if (method !== "GET") return noStore(Response.json({ error: "method-not-allowed" }, { status: 405 }));
    if (authContext.authMethod !== "nip98") {
      return noStore(Response.json({ error: "nip98-authentication-required" }, { status: 401 }));
    }
    const ownerNpub = validNpub(url.searchParams.get("owner_npub") ?? "");
    if (!ownerNpub) {
      return noStore(Response.json({
        error: "owner-selection-required",
        detail: "Pass one valid owner npub as ?owner_npub= so the signed package can advertise directly callable owner-space routes",
      }, { status: 400 }));
    }
    const access = resolveOwnerAccess(
      authContext,
      ownerNpub,
      ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
      DelegationScopes.ControlPlaneRead,
    );
    if (!access) {
      return noStore(Response.json({
        error: "control-plane-read-authority-required",
        requiredScope: DelegationScopes.ControlPlaneRead,
      }, { status: 403 }));
    }
    const isV2 = url.pathname === "/api/control-plane/v2/connect-package";
    const installation = isV2 ? readyInstallation(ctx) : readyLegacyInstallation(ctx);
    if (installation instanceof Response) return noStore(installation);
    const common = {
      identity: installation.identity,
      fipsEndpoint: installation.fips.url!,
      ownerNpub,
      httpsEndpoint: ctx.baseUrlConfigured ? ctx.baseUrl : null,
      now: ctx.now?.(),
    };
    return noStore(Response.json(isV2
      ? createAutopilotConnectPackageV2({ ...common, fipsNodeNpub: installation.fips.nodeNpub! })
      : createAutopilotConnectPackage(common)));
  }

  const route = ownerRoute(url.pathname);
  if (!route) return null;
  if (method !== "GET") return noStore(Response.json({ error: "method-not-allowed" }, { status: 405 }));
  if (authContext.authMethod !== "nip98") {
    return noStore(Response.json({ error: "nip98-authentication-required" }, { status: 401 }));
  }
  const installation = readyInstallation(ctx);
  if (installation instanceof Response) return noStore(installation);
  const access = authorisedAgents(route, authContext, ctx);
  if (access instanceof Response) return noStore(access);
  const installationId = installationIdForIdentity(installation.identity);
  if (route.resource === "manifest") {
    return noStore(Response.json(createAutopilotConnectPackage({
      identity: installation.identity,
      fipsEndpoint: installation.fips.url!,
      ownerNpub: route.ownerNpub,
      httpsEndpoint: ctx.baseUrlConfigured ? ctx.baseUrl : null,
      now: ctx.now?.(),
    }).manifest));
  }
  if (route.resource === "health") {
    const body: InstallationHealthV1 = {
      ok: true,
      installation_id: installationId,
      installation_npub: installation.identity.npub,
      api_version: CONTROL_API_VERSION,
    };
    return noStore(Response.json(body));
  }
  if (route.agentId) {
    const agent = access.agents.find((candidate) => candidate.agentId === route.agentId);
    if (!agent) return noStore(Response.json({ error: "agent-not-found" }, { status: 404 }));
    if (!route.agentResource || route.agentResource === "overview") {
      return noStore(Response.json(overview(installationId, agent, access.signerNpub, route.ownerNpub)));
    }
    if (route.agentResource === "pipelines") {
      const definitions = await ctx.listPipelineDefinitions(route.ownerNpub);
      const availabilityMode = ctx.pipelineBindingStore.getAvailabilityMode(agent.agentId);
      const defaultMode = ctx.pipelineBindingStore.getDefaultMode(agent.agentId);
      const explicitIds = ctx.pipelineBindingStore.listAvailableIds(agent.agentId);
      const assignedIds = availabilityMode === "implicit_all" ? definitions.map((definition) => definition.id) : explicitIds;
      const persistedDefaultIds = ctx.pipelineBindingStore.listDefaultIds(agent.agentId);
      const defaultIds = defaultMode === "implicit_library"
        ? definitions.filter((definition) => definition.spec.default === true).map((definition) => definition.id)
        : persistedDefaultIds;
      const overrides = ctx.pipelineBindingStore.listOverrides(agent.agentId);
      const definitionIds = new Set(definitions.map((definition) => definition.id));
      const missingDefinitionIds = Array.from(new Set([
        ...explicitIds,
        ...persistedDefaultIds,
        ...overrides.map((binding) => binding.pipelineDefinitionId),
      ].filter((id) => !definitionIds.has(id)))).sort();
      const body: AgentPipelinesV1 = {
        installation_id: installationId,
        agent_id: agent.agentId,
        bot_npub: agent.botNpub,
        availability_mode: availabilityMode,
        default_mode: defaultMode,
        available_definitions: definitions.map(definitionSummary),
        assignments: assignedIds.map((pipeline_definition_id) => ({ pipeline_definition_id })),
        defaults: defaultIds.map((pipeline_definition_id) => ({ pipeline_definition_id })),
        overrides: overrides.map((binding) => ({
          kind: binding.kind,
          context_id: binding.contextId,
          pipeline_definition_id: binding.pipelineDefinitionId,
        })),
        missing_definition_ids: missingDefinitionIds,
      };
      return noStore(Response.json(body));
    }
    ctx.schedulerStore.bindLegacyJobsToAgent(agent.agentId, agent.botNpub, route.ownerNpub);
    const jobs = ctx.schedulerStore.listJobsForAgent(agent.agentId);
    if (route.agentResource === "schedules") {
      const body: AgentSchedulesV1 = {
        installation_id: installationId,
        agent_id: agent.agentId,
        bot_npub: agent.botNpub,
        schedules: jobs.filter((job) => job.triggerType === "cron").map((job) => scheduleItem(job, agent)),
      };
      return noStore(Response.json(body));
    }
    const body: AgentTriggersV1 = {
      installation_id: installationId,
      agent_id: agent.agentId,
      bot_npub: agent.botNpub,
      triggers: jobs.filter((job) => job.triggerType !== "cron").map((job) => triggerItem(job, agent)),
    };
    return noStore(Response.json(body));
  }
  const body: AgentDiscoveryV1 = {
    installation_id: installationId,
    agents: access.agents.map((agent) => discovery(agent, access.signerNpub, route.ownerNpub)),
  };
  return noStore(Response.json(body));
}
