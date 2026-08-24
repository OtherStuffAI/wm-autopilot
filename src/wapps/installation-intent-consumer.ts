import { createHash } from "node:crypto";

import type { AppRecord } from "../apps/app-registry";
import type { RuntimeBotIdentity } from "../agent-chat/types";
import { loadYokeBotHelpers } from "../agent-chat/yoke-bot-helpers";
import { writeServerLog } from "../logging/server-logger";
import { registerTowerBackedWappAssignment } from "./tower-registration";
import type { WappStore } from "./wapp-store";

type FetchLike = typeof fetch;

export interface TowerInstallIntent {
  id: string;
  workspace_id: string;
  status: "pending" | "claimed" | "failed" | "active" | "revoked";
  intent_version: number;
  owner_npub?: string;
  claimed_by_npub?: string | null;
  request: {
    app_id: string;
    app_version: string;
    wapp_installation_id: string | null;
    title: string;
    description: string | null;
    launch_url: string;
    autopilot_origin: string;
    autopilot_npub: string;
    registered_open_origins: string[];
    capabilities: string[];
    scope_id: string | null;
    destinations: Array<{ scope_id: string; channel_id: string }>;
  };
}

export class InstallationIntentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

const exactOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new InstallationIntentError("origin_not_allowed", "Intent origins must be exact HTTPS origins");
  }
  return url.origin;
};

const stableHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, Object.keys(value as object).sort())).digest("hex");

export interface InstallationIntentConsumerDeps {
  towerUrl: string;
  autopilotOrigin: string;
  identity: RuntimeBotIdentity;
  appRegistry: { listApps(): Promise<AppRecord[]>; getApp(id: string): Promise<AppRecord | undefined> };
  appAliasRegistry: { getByAppId(id: string): Promise<{ alias: string } | undefined> };
  wappStore: WappStore;
  buildLaunchUrl(alias: string | null, app: AppRecord): string;
  fetchImpl?: FetchLike;
}

export class InstallationIntentConsumer {
  readonly #deps: InstallationIntentConsumerDeps;
  readonly #fetch: FetchLike;

  constructor(deps: InstallationIntentConsumerDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  async catalog() {
    const apps = await this.#deps.appRegistry.listApps();
    return Promise.all(apps.filter((app) => app.webApp && app.ownerNpub).map(async (app) => {
      const alias = await this.#deps.appAliasRegistry.getByAppId(app.id);
      const launchUrl = this.#deps.buildLaunchUrl(alias?.alias ?? null, app);
      return { app_id: app.id, title: app.label, app_version: app.updatedAt, launch_url: launchUrl, view_origin: new URL(launchUrl).origin, autopilot_origin: exactOrigin(this.#deps.autopilotOrigin), autopilot_npub: this.#deps.identity.botNpub };
    }));
  }

  async list(workspaceId: string): Promise<TowerInstallIntent[]> {
    const payload = await this.#towerJson("GET", `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/autopilot-wapp-install-intents`);
    return Array.isArray(payload.intents) ? payload.intents : [];
  }

  async process(workspaceId: string, intentId: string) {
    const readPath = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/autopilot-wapp-install-intents/${encodeURIComponent(intentId)}`;
    const read = await this.#towerJson("GET", readPath);
    const intent = read.intent as TowerInstallIntent;
    if (intent.status === "active") return { status: "active", replayed: true, intent };
    this.#validateIntent(intent, workspaceId);
    const observed = await this.#resolveObserved(intent);
    let claimedIntent: TowerInstallIntent | null = null;
    try {
      if (intent.status === "claimed") {
        if (intent.claimed_by_npub !== this.#deps.identity.botNpub) throw new InstallationIntentError("wrong_autopilot_identity", "Intent was claimed by a different Autopilot identity", 403);
        claimedIntent = intent;
      } else {
      const challengePayload = await this.#towerJson("POST", `${readPath}/challenge`, { intent_version: intent.intent_version });
      const challenged = challengePayload.intent as TowerInstallIntent;
      const claimed = await this.#towerJson("POST", `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/wapp-install-intents/${encodeURIComponent(intentId)}/claim`, { ...observed, challenge: challengePayload.challenge, intent_version: challenged.intent_version });
        claimedIntent = claimed.intent as TowerInstallIntent;
      }
      const completed = await this.#towerJson("POST", `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/wapp-install-intents/${encodeURIComponent(intentId)}/complete`, { ...observed, intent_version: claimedIntent.intent_version });
      writeServerLog("INFO", "[wapp-install-intent] completed", { workspaceId, intentId, appId: intent.request.app_id, installationId: observed.wapp_installation_id });
      return { status: "active", replayed: false, ...completed };
    } catch (error) {
      writeServerLog("ERROR", "[wapp-install-intent] failed", { workspaceId, intentId, code: error instanceof InstallationIntentError ? error.code : "installation_failed", message: (error as Error).message });
      if (claimedIntent) {
        await this.#towerJson("POST", `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/wapp-install-intents/${encodeURIComponent(intentId)}/fail`, { code: error instanceof InstallationIntentError ? error.code : "installation_failed", message: (error as Error).message, observed }).catch(() => null);
      }
      throw error;
    }
  }

  async reconcile(workspaceIds: string[]) {
    const results = [];
    for (const workspaceId of workspaceIds) {
      for (const intent of await this.list(workspaceId)) {
        if (intent.status === "pending" || intent.status === "claimed" || intent.status === "failed") {
          try { results.push(await this.process(workspaceId, intent.id)); }
          catch (error) { results.push({ status: "failed", workspaceId, intentId: intent.id, error: (error as Error).message }); }
        }
      }
    }
    return results;
  }

  #validateIntent(intent: TowerInstallIntent, workspaceId: string) {
    const request = intent?.request;
    if (!intent || intent.workspace_id !== workspaceId || !request) throw new InstallationIntentError("intent_mismatch", "Tower intent identity does not match the requested workspace", 409);
    if (request.autopilot_npub !== this.#deps.identity.botNpub) throw new InstallationIntentError("wrong_autopilot_identity", "Intent targets a different Autopilot identity", 403);
    if (exactOrigin(request.autopilot_origin) !== exactOrigin(this.#deps.autopilotOrigin)) throw new InstallationIntentError("wrong_autopilot_origin", "Intent targets a different Autopilot origin", 403);
    if (request.capabilities.some((value) => value !== "activity.publish")) throw new InstallationIntentError("capability_not_allowed", "Intent expands beyond activity.publish", 403);
    const launchOrigin = new URL(request.launch_url).origin;
    if (!request.registered_open_origins.includes(launchOrigin)) throw new InstallationIntentError("launch_origin_not_allowed", "Launch URL origin is not approved by the intent", 403);
  }

  async #resolveObserved(intent: TowerInstallIntent) {
    const request = intent.request;
    const app = await this.#deps.appRegistry.getApp(request.app_id);
    if (!app || !app.ownerNpub) throw new InstallationIntentError("app_not_found", "Managed app does not exist or has no owner", 404);
    if (app.updatedAt !== request.app_version) throw new InstallationIntentError("stale_app_version", "Managed app version changed after approval", 409);
    const alias = await this.#deps.appAliasRegistry.getByAppId(app.id);
    const launchUrl = this.#deps.buildLaunchUrl(alias?.alias ?? null, app);
    if (launchUrl !== request.launch_url) throw new InstallationIntentError("changed_launch_origin", "Managed app launch URL changed after approval", 409);
    if (!request.wapp_installation_id) throw new InstallationIntentError("installation_identity_required", "Intent must contain a preselected installation ID", 400);
    if (!intent.owner_npub) throw new InstallationIntentError("tower_binding_missing", "Tower did not return the immutable workspace owner", 409);
    const binding = this.#deps.wappStore.listTowerBindings().find((entry) => entry.towerUrl.replace(/\/$/, "") === this.#deps.towerUrl.replace(/\/$/, "") && entry.workspaceOwnerNpub === intent.owner_npub && (!entry.workspaceId || entry.workspaceId === intent.workspace_id));
    if (!binding) throw new InstallationIntentError("tower_binding_missing", "No Tower binding matches this workspace and owner", 409);
    let wapp = this.#deps.wappStore.get(request.wapp_installation_id);
    if (!wapp) {
      wapp = this.#deps.wappStore.create({ id: request.wapp_installation_id, appId: app.id, title: request.title, description: request.description, ownerNpub: intent.owner_npub, createdByNpub: intent.owner_npub, workspaceOwnerNpub: intent.owner_npub, scopeId: request.scope_id || request.destinations[0]?.scope_id || intent.workspace_id, allowedNpubs: [intent.owner_npub], launchUrl, sourceWingmanUrl: this.#deps.autopilotOrigin, towerBindingId: binding.id, appKeyMode: "generate", registeredOpenOrigins: request.registered_open_origins });
      await registerTowerBackedWappAssignment({ wapp, appName: app.label, authority: this.#deps.identity });
    }
    if (wapp.appId !== app.id || wapp.launchUrl !== launchUrl || wapp.registeredOpenOrigins.some((origin) => !request.registered_open_origins.includes(origin))) throw new InstallationIntentError("installation_identity_conflict", "Existing local WApp assignment conflicts with the intent", 409);
    const observed = { wapp_installation_id: wapp.wappInstallationId, app_id: app.id, app_version: app.updatedAt, publisher_npub: wapp.appNpub, launch_url: launchUrl };
    return { ...observed, attestation_hash: stableHash(observed) };
  }

  async #towerJson(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<any> {
    const url = new URL(path, this.#deps.towerUrl).toString();
    const helpers = await loadYokeBotHelpers();
    const authorization = helpers.signBotRequest({ botSecret: this.#deps.identity.botSecret, botNpub: this.#deps.identity.botNpub, url, method, body: body ?? null });
    const response = await this.#fetch(url, { method, headers: { Authorization: authorization, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new InstallationIntentError(payload.code || "tower_request_failed", payload.error || `Tower returned ${response.status}`, response.status);
    return payload;
  }
}
