import Dexie from "/vendor/dexie/dexie.mjs";

export const secretsDb = new Dexie("WingmanSecretMetadata");
secretsDb.version(1).stores({ views: "id, syncedAt" });
secretsDb.version(2).stores({ views: null, snapshots: "id, ownerNpub, syncedAt" });
export { Dexie };

export { secretMetadata } from "./metadata.js";
