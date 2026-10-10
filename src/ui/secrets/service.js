import { secretsDb, secretMetadata } from "./db.js";
import { hostedSiteGrantMetadata } from "./metadata.js";
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "include", cache: "no-store", ...options });
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error("Secrets response invalid"), { status: response.status }); }
  if (!response.ok) throw Object.assign(new Error(result.error || "Secrets request failed"), { status: response.status });
  return result;
}
async function loadHostedSiteGrants(workspace) {
  try { return { ...(await request(`/api/secrets/hosted-site-grants?workspace=${encodeURIComponent(workspace)}`)), available: true }; }
  catch (error) {
    // Staged source UI can precede server activation. Only this absent route is compatibility.
    if (error.status === 404) return { grants: [], available: false };
    throw error;
  }
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
  const [inventory, payload, hosted] = await Promise.all([loadSecretInventory(), loadSecrets(workspace),
    loadHostedSiteGrants(workspace)]);
  if (!Array.isArray(payload.secrets) || !Array.isArray(inventory.workspaces)
    || !Array.isArray(inventory.identities) || !Array.isArray(inventory.pipelines) || !Array.isArray(hosted.grants)) throw new Error("Invalid secrets metadata response");
  const previous = await secretsDb.snapshots.get(snapshotId(ownerNpub, workspace));
  await secretsDb.snapshots.put({ id: snapshotId(ownerNpub, workspace), ownerNpub, workspace,
    hostedSiteGrantAvailable: hosted.available,
    hostedSiteGrants: hosted.grants.map(hostedSiteGrantMetadata),
    hostedSiteGrantAudit: previous?.hostedSiteGrantAudit || [],
    syncedAt: Date.now(), secrets: payload.secrets.map(secretMetadata),
    inventory: {
      workspaces: inventory.workspaces.map(({ id, label }) => ({ id, label })),
      identities: inventory.identities.map(({ npub, label, type }) => ({ npub, label, type })),
      pipelines: inventory.pipelines.map(({ id, label }) => ({ id, label })),
      apps: (inventory.apps || []).map(({ id, label, root }) => ({ id, label, root })),
    }, audit: [] });
}
export async function registerHostedSiteGrant(ownerNpub, workspace, input) {
  const result = await request("/api/secrets/hosted-site-grants", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (result.credential !== undefined || !result.grant?.id || typeof result.credentialFile !== "string") throw new Error("Invalid hosted-site grant response");
  const id = snapshotId(ownerNpub, workspace);
  await secretsDb.transaction("rw", secretsDb.snapshots, async () => {
    const snapshot = await secretsDb.snapshots.get(id);
    if (!snapshot) throw new Error("Refresh secret metadata before authorizing an app");
    await secretsDb.snapshots.update(id, { hostedSiteGrants: [...(snapshot.hostedSiteGrants || []), hostedSiteGrantMetadata({ ...result.grant, credentialFile: result.credentialFile, revoked: false })] });
  });
}
export async function revokeHostedSiteGrant(ownerNpub, workspace, grantId) {
  await request(`/api/secrets/hosted-site-grants/${encodeURIComponent(grantId)}`, { method: "DELETE" });
  const id = snapshotId(ownerNpub, workspace);
  await secretsDb.transaction("rw", secretsDb.snapshots, async () => {
    const snapshot = await secretsDb.snapshots.get(id);
    await secretsDb.snapshots.update(id, { hostedSiteGrants: (snapshot?.hostedSiteGrants || []).map(grant => grant.id === grantId ? { ...grant, revoked: true } : grant) });
  });
}
export async function syncHostedSiteGrantAudit(ownerNpub, workspace, grantId) {
  const result = await request(`/api/secrets/hosted-site-grants/${encodeURIComponent(grantId)}/audit`);
  if (!Array.isArray(result.audit)) throw new Error("Invalid hosted-site grant audit");
  await secretsDb.snapshots.update(snapshotId(ownerNpub, workspace), { hostedSiteGrantAudit: result.audit.map(({ at, operation, outcome }) => ({ at, operation, outcome })) });
}
export async function syncSecretAudit(ownerNpub, workspace, id) {
  const payload = await loadSecretAudit(workspace, id);
  if (!Array.isArray(payload.audit)) throw new Error("Invalid audit response");
  await secretsDb.snapshots.update(snapshotId(ownerNpub, workspace), { auditId: id,
    audit: payload.audit.map(({ at, operation, identity, context, contextId, outcome }) => ({ at, operation, identity, context, contextId, outcome })) });
}
