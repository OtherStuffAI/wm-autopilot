import { createHash } from "node:crypto";

import type { SessionSnapshot } from "../agents/process-manager";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";
import type { GitCredentialBrokerAdapter } from "../signing/capability-broker";

interface TowerGitServiceMetadata {
  identity?: { tower_service_npub?: unknown };
  service?: { base_url?: unknown };
  git?: {
    gateway_origins?: unknown;
    audience?: unknown;
  };
}

interface TowerRepositoryList {
  repositories?: unknown;
}

interface TowerRepositorySummary {
  git_path: string;
  repository_id: string;
  workspace_id: string;
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
  method: "GET" | "POST";
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
    if (!service) throw new Error("The Git gateway is not advertised for this session.");

    const repositoriesUrl = new URL(
      `/api/v4/git/workspaces/${encodeURIComponent(service.workspaceId)}/repositories`,
      service.towerOrigin,
    ).toString();
    const repositoryList = await this.signedJson<TowerRepositoryList>({
      url: repositoriesUrl,
      method: "GET",
      appNpub: service.appNpub,
      signNip98: input.signNip98,
    });
    if (
      !Array.isArray(repositoryList.repositories)
      || !repositoryList.repositories.every(isTowerRepositorySummary)
    ) {
      throw new Error("Tower returned a malformed repository list.");
    }
    const matchingRepositories = repositoryList.repositories.filter((repository) => (
      repository.git_path === input.request.path
    ));
    if (matchingRepositories.length !== 1) {
      throw new Error("The Git path does not resolve to an advertised Tower repository.");
    }
    const repository = matchingRepositories[0]!;
    const repositoryId = repository.repository_id;
    if (repository.workspace_id !== service.workspaceId || !isUuid(repositoryId)) {
      throw new Error("Tower returned an inconsistent repository identity.");
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
    if (bindings.length === 0) throw new Error("No active Tower workspace connection matches this session.");

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
        metadata.identity?.tower_service_npub !== binding.towerServiceNpub
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
    method: "GET" | "POST";
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
    if (!response.ok) throw new Error(`Tower request failed (${response.status}).`);
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

function isTowerRepositorySummary(value: unknown): value is TowerRepositorySummary {
  if (!value || typeof value !== "object") return false;
  const repository = value as Record<string, unknown>;
  return typeof repository.git_path === "string"
    && typeof repository.repository_id === "string"
    && typeof repository.workspace_id === "string";
}

function sessionTaskId(session: SessionSnapshot): string | null {
  const metadata = session.metadata as Record<string, unknown> | undefined;
  if (metadata?.bindingType === "task" && typeof metadata.bindingId === "string" && isUuid(metadata.bindingId)) {
    return metadata.bindingId;
  }
  const taskIds = Array.isArray(metadata?.taskIds) ? metadata.taskIds : [];
  return taskIds.find((value): value is string => typeof value === "string" && isUuid(value)) ?? null;
}
