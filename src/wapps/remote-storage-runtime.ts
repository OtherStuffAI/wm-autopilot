import { writeServerLog } from "../logging/server-logger";
import { wappStore } from "./wapp-store";
import { RemoteStorageBroker } from "./remote-storage-broker";
import { RemoteStorageError, REMOTE_STORAGE_BROKER_PATH } from "./remote-storage-contract";

export function createRemoteStorageSignerGuard(input: {
  instanceIdentity: { npub: string } | null;
  botKeys: { getActiveKeyForBotNpub(npub: string): unknown };
  profiles: { listProfiles(): { botNpub: string }[] };
}): (npub: string) => boolean {
  return npub => npub === input.instanceIdentity?.npub
    || Boolean(input.botKeys.getActiveKeyForBotNpub(npub))
    || input.profiles.listProfiles().some(profile => profile.botNpub === npub);
}

let signerGuard: ((npub: string) => boolean) | undefined;
export function configureRemoteStorageSignerGuard(guard: (npub: string) => boolean): void { signerGuard = guard; }
let broker: RemoteStorageBroker | undefined;
export function getRemoteStorageBroker(): RemoteStorageBroker {
  return broker ??= new RemoteStorageBroker({ store: wappStore, forbiddenSigner: npub => {
    if (!signerGuard) throw new RemoteStorageError("storage_signer_guard_unavailable", 503);
    return signerGuard(npub);
  } });
}
/** Called only by managed start, never build/setup. Revokes old process authority. */
export function issueRemoteStorageRuntime(appId: string, port: number, storageBroker = getRemoteStorageBroker()): Record<string, string> {
  let capability: ReturnType<RemoteStorageBroker["issue"]>;
  try { capability = storageBroker.issue(appId); }
  catch (error) {
    if (!(error instanceof RemoteStorageError)) throw error;
    storageBroker.revokeApp(appId);
    writeServerLog("WARN", "Managed app storage unavailable", { appId, code: error.code });
    return { WAPP_REMOTE_STORAGE_ERROR: error.code };
  }
  if (!capability) return {};
  return { WAPP_REMOTE_STORAGE_BROKER_URL: `http://127.0.0.1:${port}${REMOTE_STORAGE_BROKER_PATH}`,
    WAPP_REMOTE_STORAGE_CAPABILITY: capability.token,
    WAPP_REMOTE_STORAGE_BINDING_JSON: JSON.stringify({ protocol: "managed-app-storage-v1", grantId: capability.grant.grantId,
      installationId: capability.grant.installationId, appId: capability.grant.appId, origin: capability.grant.origin, serviceNpub: capability.grant.serviceNpub,
      workspaceId: capability.grant.workspaceId, delegationId: capability.grant.delegationId, appNpub: capability.grant.appNpub,
      maxObjectBytes: capability.grant.maxObjectBytes, billing: capability.grant.billing, expiresAt: capability.expiresAt }),
  };
}
