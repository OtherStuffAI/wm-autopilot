import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { nip19 } from "nostr-tools";
import { REMOTE_STORAGE_MAX_OBJECT_BYTES, RemoteStorageError, storageAssert, storageObject, storageUuid } from "./remote-storage-contract";

export interface RemoteStorageGrant {
  grantId: string;
  revision: string;
  installationId: string;
  appId: string;
  ownerNpub: string;
  appNpub: string;
  towerBindingId: string | null;
  origin: string;
  serviceNpub: string;
  workspaceId: string;
  delegationId: string;
  expiresAt: string;
  maxObjectBytes: number;
  billing: "operator_budget";
}
const fields = ["grantId", "revision", "installationId", "appId", "ownerNpub", "appNpub", "towerBindingId", "origin",
  "serviceNpub", "workspaceId", "delegationId", "expiresAt", "maxObjectBytes", "billing"];
function validNpub(value: unknown) {
  try { return typeof value === "string" && nip19.decode(value).type === "npub"; } catch { return false; }
}
export function parseRemoteStorageGrants(value: unknown): RemoteStorageGrant[] {
  try {
    const root = storageObject(value, ["version", "grants"]);
    storageAssert(root.version === 1 && Array.isArray(root.grants) && root.grants.length <= 100, "storage_config_invalid", 503);
    const grants = root.grants.map(value => {
      const row = storageObject(value, fields);
      storageAssert(fields.every(key => Object.hasOwn(row, key)), "storage_config_invalid", 503);
      for (const key of ["grantId", "revision", "installationId", "appId"]) {
        storageAssert(typeof row[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row[key]), "storage_config_invalid", 503);
      }
      storageAssert(row.towerBindingId === null || (typeof row.towerBindingId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.towerBindingId)), "storage_config_invalid", 503);
      storageAssert(validNpub(row.ownerNpub) && validNpub(row.appNpub) && validNpub(row.serviceNpub)
        && row.appNpub !== row.ownerNpub && row.appNpub !== row.serviceNpub, "storage_config_invalid", 503);
      storageAssert(typeof row.origin === "string", "storage_config_invalid", 503);
      const url = new URL(row.origin);
      storageAssert(url.protocol === "https:" && row.origin.length <= 1024 && url.origin === row.origin && !url.username && !url.password
        && !url.search && !url.hash && !url.hostname.endsWith(".fips"), "storage_config_invalid", 503);
      storageAssert(storageUuid.test(String(row.workspaceId)) && storageUuid.test(String(row.delegationId)), "storage_config_invalid", 503);
      storageAssert(typeof row.expiresAt === "string" && Number.isFinite(Date.parse(row.expiresAt))
        && Number.isSafeInteger(row.maxObjectBytes) && Number(row.maxObjectBytes) > 0
        && Number(row.maxObjectBytes) <= REMOTE_STORAGE_MAX_OBJECT_BYTES && row.billing === "operator_budget", "storage_config_invalid", 503);
      return row as unknown as RemoteStorageGrant;
    });
    storageAssert(new Set(grants.map(g => g.grantId)).size === grants.length
      && new Set(grants.map(g => g.appId)).size === grants.length, "storage_config_invalid", 503);
    return grants;
  } catch { throw new RemoteStorageError("storage_config_invalid", 503); }
}
export function readRemoteStorageGrants(path = process.env.WAPP_REMOTE_STORAGE_GRANTS_FILE): RemoteStorageGrant[] {
  if (!path) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    storageAssert(stat.isFile() && stat.size <= 128 * 1024 && (stat.mode & 0o077) === 0
      && stat.uid === process.geteuid?.(), "storage_config_invalid", 503);
    return parseRemoteStorageGrants(JSON.parse(readFileSync(fd, "utf8")));
  } catch { throw new RemoteStorageError("storage_config_invalid", 503); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function storageIdentityRotationBlocked(installationId: string, grants = readRemoteStorageGrants()): boolean {
  return grants.some(grant => grant.installationId === installationId);
}

export function assertStorageIdentityRotationAllowed(installationId: string): void {
  storageAssert(!storageIdentityRotationBlocked(installationId), "storage_identity_rotation_blocked", 409);
}
