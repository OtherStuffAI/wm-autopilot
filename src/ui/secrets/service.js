import { secretsDb, secretMetadata } from "./db.js";
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "include", cache: "no-store", ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Secrets request failed");
  return result;
}
export function loadSecretInventory() { return request("/api/secrets/inventory"); }
export function loadSecrets(workspace) { return request(`/api/secrets?workspace=${encodeURIComponent(workspace)}`); }
export function loadSecretAudit(workspace, id) { return request(`/api/secrets/${encodeURIComponent(id)}/audit?workspace=${encodeURIComponent(workspace)}`); }
export function saveSecret(workspace, id, payload) {
  return request(`/api/secrets${id ? `/${encodeURIComponent(id)}` : ""}?workspace=${encodeURIComponent(workspace)}`, {
    method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}
export function revokeSecret(workspace, id, revision) {
  return request(`/api/secrets/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspace)}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision }),
  });
}

export function snapshotId(ownerNpub, workspace) { return `${ownerNpub}:${workspace}`; }
export async function syncSecrets(ownerNpub, workspace = "local") {
  const [inventory, payload] = await Promise.all([loadSecretInventory(), loadSecrets(workspace)]);
  if (!Array.isArray(payload.secrets) || !Array.isArray(inventory.workspaces)
    || !Array.isArray(inventory.identities) || !Array.isArray(inventory.pipelines)) throw new Error("Invalid secrets metadata response");
  await secretsDb.snapshots.put({ id: snapshotId(ownerNpub, workspace), ownerNpub, workspace,
    syncedAt: Date.now(), secrets: payload.secrets.map(secretMetadata),
    inventory: {
      workspaces: inventory.workspaces.map(({ id, label }) => ({ id, label })),
      identities: inventory.identities.map(({ npub, label, type }) => ({ npub, label, type })),
      pipelines: inventory.pipelines.map(({ id, label }) => ({ id, label })),
    }, audit: [] });
}
export async function syncSecretAudit(ownerNpub, workspace, id) {
  const payload = await loadSecretAudit(workspace, id);
  if (!Array.isArray(payload.audit)) throw new Error("Invalid audit response");
  await secretsDb.snapshots.update(snapshotId(ownerNpub, workspace), { auditId: id,
    audit: payload.audit.map(({ at, operation, identity, context, contextId, outcome }) => ({ at, operation, identity, context, contextId, outcome })) });
}
