import { writeServerLog } from "../logging/server-logger";
import { wappStore } from "./wapp-store";
import { isForbiddenStorageSigner } from "./remote-storage-runtime";
import { RegisteredAppStorageBroker } from "./registered-app-storage-broker";
import { REGISTERED_STORAGE_BROKER_PATH } from "./registered-app-storage-contract";
import { RemoteStorageError } from "./remote-storage-contract";

let broker: RegisteredAppStorageBroker | undefined;
export function getRegisteredAppStorageBroker(): RegisteredAppStorageBroker {
  return broker ??= new RegisteredAppStorageBroker({ store: wappStore, forbiddenSigner: isForbiddenStorageSigner });
}

export function issueRegisteredAppStorageRuntime(installationId: string, appId: string, port: number,
  storageBroker = getRegisteredAppStorageBroker(), installationIds: string[] = [installationId]): Record<string, string> {
  try {
    const capability = storageBroker.issue(installationId, appId, installationIds);
    return {
      WAPP_REGISTERED_APP_STORAGE_BROKER_URL: `http://127.0.0.1:${port}${REGISTERED_STORAGE_BROKER_PATH}`,
      WAPP_REGISTERED_APP_STORAGE_CAPABILITY: capability.token,
      WAPP_REGISTERED_APP_STORAGE_BINDINGS_JSON: JSON.stringify(capability.bindings),
    };
  } catch (error) {
    storageBroker.revokeApp(appId);
    const code = error instanceof RemoteStorageError ? error.code : "storage_installation_invalid";
    writeServerLog("WARN", "Registered app storage unavailable", { appId, code });
    return { WAPP_REGISTERED_APP_STORAGE_ERROR: code };
  }
}
