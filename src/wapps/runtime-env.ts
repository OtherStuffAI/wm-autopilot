import { join } from "node:path";

import type { WappRecord } from "./types";
import { wappStore, type WappStore } from "./wapp-store";

export interface WappTowerDbRuntimeEnvInput {
  brokerUrl: string;
  capability: string;
}

export function buildWappRuntimeEnv(
  wapp: WappRecord,
  wappRoot: string,
  towerDbBroker?: WappTowerDbRuntimeEnvInput,
): Record<string, string> {
  const baseEnv = {
    WAPP_ID: wapp.id,
    WAPP_INSTALLATION_ID: wapp.wappInstallationId,
    WAPP_APP_ID: wapp.appId,
    WAPP_PUBLISHER_NPUB: wapp.publisherNpub ?? "",
    WAPP_OWNER_NPUB: wapp.ownerNpub,
    WAPP_WORKSPACE_OWNER_NPUB: wapp.workspaceOwnerNpub,
    WAPP_SCOPE_ID: wapp.scopeId,
    WAPP_ALLOWED_NPUBS_JSON: JSON.stringify(wapp.allowedNpubs),
    WAPP_REGISTERED_OPEN_ORIGINS_JSON: JSON.stringify(wapp.registeredOpenOrigins),
    WAPP_WORKSPACE_ID: wapp.towerBinding?.workspaceId ?? "",
  };
  if (!wapp.towerBindingId) {
    return {
      ...baseEnv,
      WAPP_DB_PATH: join(wappRoot, "data", "db.sqlite"),
    };
  }
  if (!wapp.towerBinding || !wapp.appNpub) {
    throw new Error(`WApp ${wapp.id} has an incomplete Tower binding`);
  }
  if (!towerDbBroker?.brokerUrl || !towerDbBroker.capability) {
    throw new Error(`WApp ${wapp.id} requires an installation-scoped Tower DB broker capability`);
  }
  return {
    ...baseEnv,
    APP_ID: wapp.appId,
    APP_LABEL: wapp.title,
    TOWER_URL: wapp.towerBinding.towerUrl,
    WORKSPACE_OWNER_NPUB: wapp.towerBinding.workspaceOwnerNpub,
    USER_ALIAS: wapp.towerBinding.userAlias ?? "",
    WAPP_DB_MODE: "tower-api",
    WAPP_APP_NPUB: wapp.appNpub,
    WAPP_TOWER_BINDING_ID: wapp.towerBinding.id,
    WAPP_TOWER_URL: wapp.towerBinding.towerUrl,
    WAPP_TOWER_WORKSPACE_ID: wapp.towerBinding.workspaceId ?? "",
    WAPP_TOWER_WORKSPACE_OWNER_NPUB: wapp.towerBinding.workspaceOwnerNpub,
    WAPP_TOWER_DB_BROKER_URL: towerDbBroker.brokerUrl,
    WAPP_TOWER_DB_CAPABILITY: towerDbBroker.capability,
  };
}

export function getWappRuntimeEnvForWapp(
  wappId: string,
  appRoot: string,
  store: WappStore = wappStore,
  towerDbBroker?: WappTowerDbRuntimeEnvInput,
): Record<string, string> {
  const wapp = store.get(wappId);
  if (!wapp || wapp.recordState !== "active") return {};
  return buildWappRuntimeEnv(wapp, appRoot, towerDbBroker);
}

export function getWappRuntimeEnvForApp(
  appId: string,
  appRoot: string,
  store: WappStore = wappStore,
  towerDbBroker?: WappTowerDbRuntimeEnvInput,
): Record<string, string> {
  const wapp = store.getByAppId(appId);
  if (!wapp) return {};
  return getWappRuntimeEnvForWapp(wapp.id, appRoot, store, towerDbBroker);
}
