import { parseTowerError, type FetchLike } from "../agent-chat/tower-client";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import { loadYokeBotHelpers } from "../agent-chat/yoke-bot-helpers";
import type { WappRecord } from "./types";

export interface TowerWappRegistrationInput {
  towerUrl: string;
  workspaceOwnerNpub: string;
  appNpub: string;
  wappInstallationId?: string;
  publisherNpub?: string;
  registeredOpenOrigins?: string[];
  appName: string;
  authority: RuntimeBotIdentity;
}

export interface TowerWappRegistrationResult {
  workspaceOwnerNpub: string;
  appNpub: string;
  app: Record<string, unknown> | null;
}

export interface TowerWappRegistrar {
  register(input: TowerWappRegistrationInput): Promise<TowerWappRegistrationResult>;
}

export class TowerWappRegistrationError extends Error {
  readonly status: number | null;
  readonly detailCode: string | null;
  readonly details: unknown;

  constructor(message: string, options: { status?: number | null; detailCode?: string | null; details?: unknown } = {}) {
    super(message);
    this.name = "TowerWappRegistrationError";
    this.status = options.status ?? null;
    this.detailCode = options.detailCode ?? null;
    this.details = options.details;
  }
}

export async function isRegisteredTowerWappDescriptor(response: Response): Promise<boolean> {
  if (response.ok) return true;
  if (response.status !== 404) return false;

  const payload = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return payload?.code === "namespace_not_provisioned";
}

export class HttpTowerWappRegistrar implements TowerWappRegistrar {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async register(input: TowerWappRegistrationInput): Promise<TowerWappRegistrationResult> {
    return registerTowerWappWithTower(input, this.fetchImpl);
  }
}

export function requireTowerWappRegistrationIdentity(
  identity: RuntimeBotIdentity | null | undefined,
): RuntimeBotIdentity {
  if (!identity) {
    throw new TowerWappRegistrationError("Tower-backed WApps require a configured Wingman instance identity for Tower registration", {
      status: 503,
      detailCode: "tower_registration_identity_missing",
    });
  }
  return identity;
}

export async function registerTowerBackedWappAssignment(input: {
  wapp: WappRecord;
  appName: string;
  authority: RuntimeBotIdentity;
  registrar?: TowerWappRegistrar;
}): Promise<TowerWappRegistrationResult> {
  const { wapp } = input;
  if (!wapp.towerBindingId) {
    throw new TowerWappRegistrationError(`WApp ${wapp.id} is not Tower-backed`, {
      detailCode: "wapp_not_tower_backed",
    });
  }
  if (!wapp.towerBinding) {
    throw new TowerWappRegistrationError(`Tower-backed WApp ${wapp.id} is missing Tower binding ${wapp.towerBindingId}`, {
      detailCode: "wapp_tower_binding_missing",
    });
  }
  if (!wapp.appNpub) {
    throw new TowerWappRegistrationError(`Tower-backed WApp ${wapp.id} is missing the derived app npub`, {
      detailCode: "wapp_app_npub_missing",
    });
  }
  const registrar = input.registrar ?? new HttpTowerWappRegistrar();
  return await registrar.register({
    towerUrl: wapp.towerBinding.towerUrl,
    workspaceOwnerNpub: wapp.towerBinding.workspaceOwnerNpub,
    appNpub: wapp.appNpub,
    wappInstallationId: wapp.wappInstallationId,
    publisherNpub: wapp.appNpub,
    registeredOpenOrigins: wapp.registeredOpenOrigins,
    appName: input.appName,
    authority: input.authority,
  });
}

export async function registerTowerWappWithTower(
  input: TowerWappRegistrationInput,
  fetchImpl: FetchLike = fetch,
  helperLoader: typeof loadYokeBotHelpers = loadYokeBotHelpers,
): Promise<TowerWappRegistrationResult> {
  const path = `/api/v4/workspaces/${encodeURIComponent(input.workspaceOwnerNpub)}/apps`;
  const url = new URL(path, input.towerUrl).toString();
  const body = {
    app_npub: input.appNpub,
    app_name: input.appName,
    capabilities: ["wapp", "app-db"],
    enabled: true,
    ...(input.wappInstallationId ? {
      metadata: {
        wapp_installation_id: input.wappInstallationId,
        publisher_npub: input.publisherNpub ?? input.appNpub,
        registered_open_origins: input.registeredOpenOrigins ?? [],
      },
    } : {}),
  };
  const helpers = await helperLoader();
  const authorization = helpers.signBotRequest({
    botSecret: input.authority.botSecret,
    botNpub: input.authority.botNpub,
    url,
    method: "POST",
    body,
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await parseTowerError(response, "wapp_workspace_app_register");
    throw new TowerWappRegistrationError(error.message, {
      status: error.status,
      detailCode: error.detailCode,
      details: error.details,
    });
  }
  const payload = await response.json().catch(() => null) as { app?: Record<string, unknown> } | null;
  return {
    workspaceOwnerNpub: input.workspaceOwnerNpub,
    appNpub: input.appNpub,
    app: payload?.app ?? null,
  };
}
