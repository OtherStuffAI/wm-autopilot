import { boundedResponse } from "./bounded-response.ts";
import { resolve } from "node:path";
import { RecordSyncCache } from "./record-sync-cache.ts";
import { record } from "./record-sync-protocol.ts";
import { createHash } from "node:crypto";
import { capabilityClientContextFromEnv, readCapabilityIdentity, callCapabilityBroker, type CapabilityClientContext } from "../mcp/capability-client.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Saved wake evidence must identify an obsolete generation retained in this cache. */
export function obsoleteRegistration(cache: RecordSyncCache, evidence: unknown): string {
  const saved = record(evidence);
  const prior = record(saved.cache);
  const current = cache.assertWriter();
  if (typeof prior.path !== "string" || resolve(prior.path) !== resolve(cache.path)
    || saved.botNpub !== cache.partition[3]
    || typeof prior.clientId !== "string" || !uuid.test(prior.clientId)
    || prior.clientId === current.clientId || prior.generation === current.generation
    || typeof prior.generation !== "string") throw new Error("Evidence does not identify an obsolete registration of this cache");
  const retained = cache.db.query("SELECT 1 FROM rows WHERE generation=? LIMIT 1").get(prior.generation);
  if (!retained) throw new Error("Evidence generation has no retained downloads in this cache");
  return prior.clientId;
}

/** Explicit finite-host operation: no bounded-route denial fallback; explicit reset archives local state. */
export async function retireObsoleteRegistration(cache: RecordSyncCache, evidence: unknown,
  context: CapabilityClientContext = capabilityClientContextFromEnv(), resetCurrent = false) {
  const deadline = Date.now() + 120_000;
  const fetchImpl = context.fetch ?? fetch;
  context = { ...context, fetch: ((input, init) => boundedResponse(fetchImpl, input, init, Math.min(deadline, Date.now() + 30_000))) as typeof fetch };
  const saved = record(evidence);
  const priorCache = record(saved.cache);
  const current = cache.assertWriter();
  if (resetCurrent && (current.available || priorCache.clientId !== current.clientId || priorCache.generation !== current.generation
    || priorCache.path !== cache.path || saved.botNpub !== cache.partition[3]
    || !Array.isArray(saved.errors) || !saved.errors.some(e => typeof e === "string" && /\b(reset_required|history_pruned|client_expired|client_not_registered|page_token_invalid)\b/.test(e))))
    throw new Error("Current reset requires matching failed-wake evidence");
  const clientId = resetCurrent ? current.clientId : obsoleteRegistration(cache, evidence);
  const identity = await readCapabilityIdentity(context);
  if (identity.identityType !== "agent" || identity.botNpub !== cache.partition[3])
    throw new Error("Retirement signer differs from cache owner");
  const active = record(await callCapabilityBroker("/api/mcp/wingman/flightdeck", { action: "context" }, context));
  const workspace = record(active.workspace);
  const [tower, workspaceId, appNpub] = cache.partition;
  if (workspace.workspaceId !== workspaceId || String(workspace.backendBaseUrl).replace(/\/$/, "") !== tower
    || workspace.sourceAppNpub !== appNpub) throw new Error("Retirement requires the exact bound cache workspace");
  const url = `${tower}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId!)}/record-sync/clients/${clientId}?protocol_version=2`;
  async function request(method: "GET" | "DELETE") {
    const prepared = await callCapabilityBroker<{ url: string }>("/api/mcp/wingman/flightdeck", { action: "transport_prepare", url, method }, context);
    const signed = await callCapabilityBroker<{ token: string }>("/api/mcp/capabilities/nip98", { url: prepared.url, method }, context);
    const response = await callCapabilityBroker<{ status: number; bodyBase64: string }>("/api/mcp/wingman/flightdeck", {
      action: "transport_request", url: prepared.url, method,
      headers: [["authorization", signed.token], ["x-flightdeck-pg-app-npub", appNpub!], ["accept", "application/json"]], bodyBase64: null,
    }, context);
    if (typeof response.bodyBase64 !== "string" || response.bodyBase64.length > 16384) throw new Error("Invalid retirement response bound");
    return { status: response.status, payload: record(JSON.parse(Buffer.from(response.bodyBase64, "base64").toString("utf8"))) };
  }
  const prior = await request("GET");
  if (!(resetCurrent && prior.status === 200) && (prior.status !== 409 || !["reset_required", "client_expired", "history_pruned", "client_not_registered"].includes(String(prior.payload.error))))
    throw new Error("Obsolete registration is not reset, expired, pruned or absent; refusing retirement");
  cache.assertWriter();
  if (prior.payload.error === "client_not_registered") {
    if (resetCurrent) cache.rebootstrap();
    return { clientId, retired: false, alreadyAbsent: true };
  }
  const result = await request("DELETE");
  if (result.status !== 200 || result.payload.protocol_version !== 2 || result.payload.client_id !== clientId || result.payload.retired !== true)
    throw new Error(`Retirement failed (${result.status}); read back before retry`);
  if (resetCurrent) cache.rebootstrap();
  // Evidence contains only the obsolete identity and result, never signatures/cursors.
  return { clientId, retired: true, evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
