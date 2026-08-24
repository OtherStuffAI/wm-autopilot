import { callCapabilityBroker, readCapabilityIdentity, type CapabilityClientContext } from "../mcp/capability-client";

type JsonRecord = Record<string, unknown>;

export interface HeartbeatWakeOptions {
  hours: number;
  towerUrl: string;
  appNpub: string;
  context?: CapabilityClientContext;
  fetchImpl?: typeof fetch;
}
export interface HeartbeatWakeResult {
  generatedAt: string;
  since: string;
  botNpub: string;
  brokerRequests: number;
  workspaces: Array<{ id: string; label: string | null; sync: JsonRecord }>;
}

function array(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object") : [];
}

async function signedGet(url: string, appNpub: string, context: CapabilityClientContext | undefined, fetchImpl: typeof fetch): Promise<JsonRecord> {
  const signed = await callCapabilityBroker<{ token: string }>(
    "/api/mcp/capabilities/nip98",
    { url, method: "GET" },
    context,
  );
  const response = await fetchImpl(url, { headers: { accept: "application/json", authorization: signed.token, "x-flightdeck-pg-app-npub": appNpub } });
  const payload = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(`Heartbeat snapshot GET ${new URL(url).pathname} failed (${response.status}): ${String(payload.error ?? response.statusText)}`);
  return payload;
}

export async function runHeartbeatWake(options: HeartbeatWakeOptions): Promise<HeartbeatWakeResult> {
  const fetchImpl = options.fetchImpl ?? options.context?.fetch ?? fetch;
  const towerUrl = options.towerUrl.replace(/\/$/, "");
  const identity = await readCapabilityIdentity(options.context);
  const workspacePayload = await signedGet(`${towerUrl}/api/v4/flightdeck-pg/workspaces?limit=100`, options.appNpub, options.context, fetchImpl);
  const workspaces = array(workspacePayload.workspaces);
  const since = new Date(Date.now() - options.hours * 60 * 60_000).toISOString();
  const snapshots = [];
  for (const workspace of workspaces) {
    const identityRecord = workspace.identity && typeof workspace.identity === "object" ? workspace.identity as JsonRecord : {};
    const id = String(identityRecord.workspace_id ?? workspace.id ?? "").trim();
    if (!id) throw new Error("Flight Deck workspace response is missing its workspace id");
    const syncUrl = `${towerUrl}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(id)}/sync?since=${encodeURIComponent(since)}&limit=2000`;
    const sync = await signedGet(syncUrl, options.appNpub, options.context, fetchImpl);
    snapshots.push({ id, label: typeof workspace.label === "string" ? workspace.label : null, sync });
  }
  return {
    generatedAt: new Date().toISOString(),
    since,
    botNpub: identity.botNpub,
    brokerRequests: 2 + workspaces.length,
    workspaces: snapshots,
  };
}
