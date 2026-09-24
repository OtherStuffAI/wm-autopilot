import type { AgentDefinitionRecord } from "../agent-chat/types";
import { DelegationScopes, resolveOwnerAccess } from "../auth/delegation-access";
import type { RequestAuthContext } from "../auth/request-context";
import {
  CONTROL_API_VERSION,
  createAutopilotConnectPackage,
  installationIdForIdentity,
} from "../control-plane/connect-package";
import type { AgentDiscoveryItemV1, AgentDiscoveryV1, AgentOverviewV1, InstallationHealthV1 } from "../control-plane/contracts";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import { normaliseNpub } from "../identity/npub-utils";
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
  if (fips.nodeNpub !== ctx.identity.npub) {
    return Response.json({
      error: "fips-identity-mismatch",
      detail: "The listening FIPS service identity does not match the Autopilot package signer",
    }, { status: 503 });
  }
  return { identity: ctx.identity, fips };
}

function discovery(agent: AgentDefinitionRecord, signerNpub: string): AgentDiscoveryItemV1 {
  return {
    agent_id: agent.agentId,
    bot_npub: agent.botNpub,
    name: agent.publicProfile?.name || agent.label || agent.agentId,
    description: agent.publicProfile?.about ?? "",
    can_instruct: agent.instructorNpubs?.includes(signerNpub) ?? false,
  };
}

function overview(installationId: string, agent: AgentDefinitionRecord, signerNpub: string): AgentOverviewV1 {
  return {
    installation_id: installationId,
    agent: {
      ...discovery(agent, signerNpub),
      picture: agent.publicProfile?.picture ?? null,
      nip05: agent.publicProfile?.nip05 ?? null,
      capabilities: [...agent.capabilities],
      enabled: agent.enabled,
      archived: agent.archived === true,
    },
  };
}

function ownerRoute(pathname: string): { ownerNpub: string; resource: string; agentId: string | null } | null {
  const match = pathname.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/(manifest|health|agents)(?:\/([^/]+))?$/);
  if (!match) return null;
  let ownerNpub: string | null;
  try {
    ownerNpub = validNpub(decodeURIComponent(match[1]!));
  } catch {
    return null;
  }
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
    const ownerNpub = validNpub(url.searchParams.get("owner_npub") ?? "");
    if (!ownerNpub) {
      return noStore(Response.json({
        error: "owner-selection-required",
        detail: "Pass one valid owner npub as ?owner_npub= so the signed package can advertise directly callable owner-space routes",
      }, { status: 400 }));
    }
    const installation = readyInstallation(ctx);
    if (installation instanceof Response) return noStore(installation);
    return noStore(Response.json(createAutopilotConnectPackage({
      identity: installation.identity,
      fipsEndpoint: installation.fips.url!,
      ownerNpub,
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
    return noStore(Response.json(overview(installationId, agent, access.signerNpub)));
  }
  const body: AgentDiscoveryV1 = {
    installation_id: installationId,
    agents: access.agents.map((agent) => discovery(agent, access.signerNpub)),
  };
  return noStore(Response.json(body));
}
