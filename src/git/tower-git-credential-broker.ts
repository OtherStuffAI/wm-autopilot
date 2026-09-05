import { TowerGitError, towerGitResponseError } from "./tower-git-error";
import { createHash } from "node:crypto";

import type { SessionSnapshot } from "../agents/process-manager";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";
import type { GitCredentialBrokerAdapter } from "../signing/capability-broker";

interface TowerGitServiceMetadata {
  service?: { base_url?: unknown; service_npub?: unknown };
  git?: {
    gateway_origins?: unknown;
    audience?: unknown;
  };
}

interface TowerRepositoryResolution {
  canonical_path?: unknown;
  repository?: {
    repository_id?: unknown;
    workspace_id?: unknown;
  };
}

interface TowerCredentialExchange {
  username?: unknown;
  capability?: unknown;
  expires_at?: unknown;
  repository_id?: unknown;
  audience?: unknown;
}

interface DiscoveredTowerGitService {
  towerOrigin: string;
  appNpub: string;
  workspaceId: string;
  gatewayOrigins: string[];
  audience: string;
}

type SignNip98 = (input: {
  url: string;
  method: "GET" | "POST" | "PUT";
  bodyHash?: string;
}) => Promise<string>;

export interface TowerGitCredentialBrokerDependencies {
  listSubscriptions: () => WorkspaceSubscriptionRecord[];
  fetch?: typeof globalThis.fetch;
  getAutopilotInstanceNpub?: () => string | null;
}

export class TowerGitCredentialBroker implements GitCredentialBrokerAdapter {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly deps: TowerGitCredentialBrokerDependencies) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  async discover(input: {
    session: SessionSnapshot;
    botNpub: string;
    workspaceId: string;
    signNip98: SignNip98;
  }): Promise<{ gatewayOrigins: string[] }> {
    const services = await this.discoverServices(input);
    return { gatewayOrigins: [...new Set(services.flatMap((service) => service.gatewayOrigins))].sort() };
  }

  async bootstrap(input: {
    session: SessionSnapshot; botNpub: string; workspaceId: string; signNip98: SignNip98;
    action: "status" | "request" | "username" | "repositories"; username?: string; towerOrigin?: string;
  }): Promise<unknown> {
    const services = await this.discoverServices(input);
    const matches = services.filter((service) => !input.towerOrigin || service.towerOrigin === input.towerOrigin);
    if (matches.length !== 1) throw new TowerGitError("discovery", 409, "git_active_tower_ambiguous");
    const service = matches[0]!;
    const suffix = input.action === "username" ? "actor-username" : input.action === "repositories" ? "repositories" : "actor-bootstrap";
    return this.signedJson({
      url: `${service.towerOrigin}/api/v4/git/workspaces/${encodeURIComponent(input.workspaceId)}/${suffix}`,
      method: input.action === "request" ? "POST" : input.username !== undefined ? "PUT" : "GET",
      ...(input.action === "request" ? { body: "{}" } : input.username !== undefined ? { body: JSON.stringify({ username: input.username }) } : {}),
      appNpub: service.appNpub, signNip98: input.signNip98,
    });
  }

  async exchange(input: {
    session: SessionSnapshot;
    botNpub: string;
    workspaceId: string;
    request: {
      protocol: "https";
      host: string;
      gatewayOrigin: string;
      path: string;
      organization: string;
      repository: string;
    };
    signNip98: SignNip98;
  }): Promise<{ username: string; password: string; expiresAt: string }> {
    const services = await this.discoverServices(input);
    const service = services.find((candidate) => candidate.gatewayOrigins.includes(input.request.gatewayOrigin));
    if (!service) throw new TowerGitError("discovery", 403, "git_gateway_not_advertised");

    const resolveUrl = new URL(
      `/api/v4/git/workspaces/${encodeURIComponent(service.workspaceId)}/repositories/resolve`,
      service.towerOrigin,
    );
    resolveUrl.searchParams.set("path", input.request.path);
    const resolution = await this.signedJson<TowerRepositoryResolution>({
      url: resolveUrl.toString(),
      method: "GET",
      appNpub: service.appNpub,
      signNip98: input.signNip98,
    });
    const repositoryId = typeof resolution.repository?.repository_id === "string"
      ? resolution.repository.repository_id
      : "";
    const repositoryWorkspaceId = typeof resolution.repository?.workspace_id === "string"
      ? resolution.repository.workspace_id
      : "";
    if (
      resolution.canonical_path !== input.request.path
      || repositoryWorkspaceId !== service.workspaceId
      || !isUuid(repositoryId)
    ) {
      throw new Error("Tower returned an inconsistent repository resolution.");
    }

    const exchangeUrl = new URL("/api/v4/git/credential-exchanges", service.towerOrigin).toString();
    const body: Record<string, string> = {
      repository_id: repositoryId,
      audience: service.audience,
      session_id: input.session.id,
    };
    const instanceNpub = this.deps.getAutopilotInstanceNpub?.()?.trim();
    if (instanceNpub) body.autopilot_instance_npub = instanceNpub;
    const taskId = sessionTaskId(input.session);
    if (taskId) body.task_id = taskId;
    const rawBody = JSON.stringify(body);
    const exchange = await this.signedJson<TowerCredentialExchange>({
      url: exchangeUrl,
      method: "POST",
      body: rawBody,
      appNpub: service.appNpub,
      signNip98: input.signNip98,
    });
    const expiresAt = typeof exchange.expires_at === "string" ? exchange.expires_at : "";
    const expiresAtMs = Date.parse(expiresAt);
    if (
      exchange.username !== "nostr"
      || typeof exchange.capability !== "string"
      || exchange.capability.length < 20
      || exchange.repository_id !== repositoryId
      || exchange.audience !== service.audience
      || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= Date.now()
    ) {
      throw new Error("Tower returned a malformed Git credential exchange.");
    }
    return { username: "nostr", password: exchange.capability, expiresAt };
  }

  private async discoverServices(input: {
    botNpub: string;
    workspaceId: string;
    signNip98: SignNip98;
  }): Promise<DiscoveredTowerGitService[]> {
    const bindings = this.deps.listSubscriptions().filter((subscription) => (
      subscription.lifecycleStatus === "active"
      && subscription.workspaceId === input.workspaceId
      && subscription.botNpub === input.botNpub
    ));
    if (bindings.length === 0) throw new TowerGitError("discovery", 409, "git_active_workspace_missing");

    const uniqueBindings = [...new Map(bindings.map((binding) => [
      `${new URL(binding.backendBaseUrl).origin}\u0000${binding.sourceAppNpub}`,
      binding,
    ])).values()];
    return await Promise.all(uniqueBindings.map(async (binding) => {
      const towerOrigin = new URL(binding.backendBaseUrl).origin;
      const metadata = await this.signedJson<TowerGitServiceMetadata>({
        url: new URL("/api/v4/flightdeck-pg/service", towerOrigin).toString(),
        method: "GET",
        appNpub: binding.sourceAppNpub,
        signNip98: input.signNip98,
      });
      if (
        metadata.service?.service_npub !== binding.towerServiceNpub
        || metadata.service?.base_url !== towerOrigin
      ) {
        throw new Error("Tower service metadata does not match the active connection.");
      }
      const audience = typeof metadata.git?.audience === "string" ? metadata.git.audience.trim() : "";
      const rawOrigins = Array.isArray(metadata.git?.gateway_origins) ? metadata.git.gateway_origins : [];
      const gatewayOrigins = rawOrigins.map((value) => normalizeGatewayOrigin(value));
      if (!audience || gatewayOrigins.length === 0) {
        throw new Error("Tower service metadata does not advertise Git.");
      }
      return {
        towerOrigin,
        appNpub: binding.sourceAppNpub,
        workspaceId: input.workspaceId,
        audience,
        gatewayOrigins: [...new Set(gatewayOrigins)].sort(),
      };
    }));
  }

  private async signedJson<T>(input: {
    url: string;
    method: "GET" | "POST" | "PUT";
    appNpub: string;
    body?: string;
    signNip98: SignNip98;
  }): Promise<T> {
    const bodyHash = input.body
      ? createHash("sha256").update(input.body).digest("hex")
      : undefined;
    const authorization = await input.signNip98({
      url: input.url,
      method: input.method,
      bodyHash,
    });
    const response = await this.fetchImpl(input.url, {
      method: input.method,
      redirect: "error",
      headers: {
        authorization,
        "x-flightdeck-pg-app-npub": input.appNpub,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      body: input.body,
    });
    if (!response.ok) {
      const path = new URL(input.url).pathname;
      const stage = path.endsWith('/service') ? 'discovery' : path.endsWith('/resolve') ? 'repository resolution'
        : path.endsWith('/credential-exchanges') ? 'credential exchange' : 'bootstrap';
      throw await towerGitResponseError(response, stage);
    }
    return await response.json() as T;
  }
}

function normalizeGatewayOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Tower advertised an invalid Git gateway origin.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Tower advertised an invalid Git gateway origin.");
  }
  return url.origin;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sessionTaskId(session: SessionSnapshot): string | null {
  const metadata = session.metadata as Record<string, unknown> | undefined;
  if (metadata?.bindingType === "task" && typeof metadata.bindingId === "string" && isUuid(metadata.bindingId)) {
    return metadata.bindingId;
  }
  const taskIds = Array.isArray(metadata?.taskIds) ? metadata.taskIds : [];
  return taskIds.find((value): value is string => typeof value === "string" && isUuid(value)) ?? null;
}
