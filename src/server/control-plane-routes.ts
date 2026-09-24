import type { AgentDefinitionRecord } from "../agent-chat/types";
import { DelegationScopes, resolveOwnerAccess } from "../auth/delegation-access";
import type { RequestAuthContext } from "../auth/request-context";
import {
  CONTROL_API_VERSION,
  CONTROL_READ_CAPABILITIES,
  createAutopilotConnectPackage,
  installationIdForIdentity,
} from "../control-plane/connect-package";
import type { AgentDiscoveryV1, AgentOverviewV1, InstallationHealthV1, InstallationManifestV1 } from "../control-plane/contracts";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { normaliseNpub } from "../identity/npub-utils";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import type { FipsAppEndpoint } from "../apps/fips-app-ingress-manager";

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
  now?: () => Date;
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
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

function discovery(agent: AgentDefinitionRecord, signerNpub: string): AgentDiscoveryV1 {
  return {
    agentId: agent.agentId,
    botNpub: agent.botNpub,
    displayName: agent.publicProfile?.name || agent.label || agent.agentId,
    picture: agent.publicProfile?.picture ?? null,
    capabilities: [...agent.capabilities],
    canInstruct: agent.instructorNpubs?.includes(signerNpub) ?? false,
  };
}

function overview(agent: AgentDefinitionRecord, signerNpub: string): AgentOverviewV1 {
  return {
    ...discovery(agent, signerNpub),
    about: agent.publicProfile?.about ?? null,
    nip05: agent.publicProfile?.nip05 ?? null,
    enabled: agent.enabled,
    archived: agent.archived === true,
  };
}

function ownerRoute(pathname: string): { ownerNpub: string; resource: string; agentId: string | null } | null {
  const match = pathname.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/(manifest|health|agents)(?:\/([^/]+))?$/);
  if (!match) return null;
  const ownerNpub = normaliseNpub(decodeURIComponent(match[1]!));
  if (!ownerNpub) return null;
  return { ownerNpub, resource: match[2]!, agentId: match[3] ? decodeURIComponent(match[3]) : null };
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
  if (url.pathname === "/api/control-plane/v1/connect-package") {
    if (method !== "GET") return noStore(Response.json({ error: "method-not-allowed" }, { status: 405 }));
    const installation = readyInstallation(ctx);
    if (installation instanceof Response) return noStore(installation);
    return noStore(Response.json(createAutopilotConnectPackage({
      identity: installation.identity,
      fipsEndpoint: installation.fips.url!,
      httpsEndpoint: ctx.baseUrlConfigured ? ctx.baseUrl : null,
      now: ctx.now?.(),
    })));
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
    const body: InstallationManifestV1 = {
      apiVersion: CONTROL_API_VERSION,
      installationId,
      installationNpub: installation.identity.npub,
      fipsEndpoint: installation.fips.url!,
      httpsEndpoint: ctx.baseUrlConfigured ? new URL(ctx.baseUrl).toString() : null,
      readCapabilities: [...CONTROL_READ_CAPABILITIES],
    };
    return noStore(Response.json(body));
  }
  if (route.resource === "health") {
    const body: InstallationHealthV1 = {
      apiVersion: CONTROL_API_VERSION,
      installationId,
      status: "healthy",
      fips: { status: installation.fips.status, endpoint: installation.fips.url, error: installation.fips.error ?? null },
      checkedAt: (ctx.now?.() ?? new Date()).toISOString(),
    };
    return noStore(Response.json(body));
  }
  if (route.agentId) {
    const agent = access.agents.find((candidate) => candidate.agentId === route.agentId);
    if (!agent) return noStore(Response.json({ error: "agent-not-found" }, { status: 404 }));
    return noStore(Response.json({ apiVersion: CONTROL_API_VERSION, installationId, agent: overview(agent, access.signerNpub) }));
  }
  return noStore(Response.json({
    apiVersion: CONTROL_API_VERSION,
    installationId,
    agents: access.agents.map((agent) => discovery(agent, access.signerNpub)),
  }));
}
