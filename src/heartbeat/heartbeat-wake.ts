import { snapshotSaturation, type SnapshotSaturation } from "./snapshot-saturation.ts";
import { callCapabilityBroker, capabilityClientContextFromEnv, readCapabilityIdentity, type CapabilityClientContext } from "../mcp/capability-client";

type JsonRecord = Record<string, unknown>;
export interface HeartbeatWakeOptions {
  hours: number;
  workspaceId?: string;
  towerUrl?: string;
  appNpub?: string;
  maxPages?: number;
  maxTimeMs?: number;
  requestTimeoutMs?: number;
  context?: CapabilityClientContext;
  fetchImpl?: typeof fetch;
}
export function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error("Snapshot collection is missing or invalid");
  return value.map(item => {
    const row = record(item);
    if (!Object.keys(row).length) throw new Error("Invalid snapshot record");
    return row;
  });
}
function mergeRows(previous: unknown, incoming: unknown): JsonRecord[] {
  const rows = new Map<string, JsonRecord>();
  for (const row of [...records(previous ?? []), ...records(incoming)]) {
    const id = row.id ?? row.entity_id ?? record(row.actor).id;
    if (typeof id !== "string" || !id) throw new Error("Snapshot record is missing id");
    rows.set(id, row);
  }
  return [...rows.values()];
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive finite integer`);
  return value;
}

export async function runHeartbeatWake(options: HeartbeatWakeOptions) {
  const start = Date.now();
  const maxPages = positive(options.maxPages ?? 100, "maxPages");
  const maxTimeMs = positive(options.maxTimeMs ?? 120_000, "maxTimeMs");
  const requestTimeoutMs = positive(options.requestTimeoutMs ?? 15_000, "requestTimeoutMs");
  if (!Number.isFinite(options.hours) || options.hours <= 0 || options.hours > 168) throw new Error("hours must be between 0 and 168");
  const baseContext = options.context ?? capabilityClientContextFromEnv();
  const baseFetch = options.fetchImpl ?? baseContext.fetch ?? fetch;
  // Bound broker signing/context/identity as well as Tower and response-body reads.
  const boundedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const remaining = maxTimeMs - (Date.now() - start);
    if (remaining <= 0) throw new Error("Snapshot time budget exhausted");
    const controller = new AbortController();
    const timeout = Math.min(requestTimeoutMs, remaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await baseFetch(input, { ...init, signal: controller.signal });
          const body = await response.arrayBuffer();
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error(`Request timed out after ${timeout}ms`)); }, timeout);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }) as typeof fetch;
  const context = { ...baseContext, fetch: boundedFetch };
  let brokerRequests = 0;
  const broker = async <T>(path: string, body: JsonRecord) => {
    brokerRequests++;
    return await callCapabilityBroker<T>(path, body, context);
  };
  const active = record(await broker<JsonRecord>("/api/mcp/wingman/flightdeck", { action: "context" }));
  const workspace = record(active.workspace);
  const workspaceId = options.workspaceId?.trim() || String(workspace.workspaceId ?? "").trim();
  if (!workspaceId) throw new Error("Explicit --workspace or active broker Flight Deck workspace is required");
  const hasWorkspaceBinding = Boolean(String(workspace.workspaceId ?? "").trim());
  const towerUrl = String(hasWorkspaceBinding ? workspace.backendBaseUrl ?? "" : options.towerUrl ?? "").trim().replace(/\/$/, "");
  const appNpub = String(hasWorkspaceBinding ? workspace.sourceAppNpub ?? "" : options.appNpub ?? "").trim();
  if (!hasWorkspaceBinding && (!options.workspaceId?.trim() || !towerUrl || !appNpub)) {
    throw new Error("Unbound broker context requires explicit --workspace, --tower-url and --app-npub");
  }
  if (!towerUrl || !appNpub) throw new Error("Broker Flight Deck context is missing authoritative Tower/app namespace");
  if ((options.towerUrl && options.towerUrl.replace(/\/$/, "") !== towerUrl) || (options.appNpub && options.appNpub !== appNpub)) {
    throw new Error("Tower/app override does not match authoritative broker context");
  }
  brokerRequests++;
  const identity = await readCapabilityIdentity(context);
  if (!identity.botNpub || identity.identityType !== "agent") throw new Error("Missing broker agent identity");
  const sync: JsonRecord = { channels: [], channel_bundles: [] };
  const rawPages: JsonRecord[] = [];
  const errors: string[] = [];
  const saturation = new Map<string, SnapshotSaturation>();
  const channels = new Set<string>();
  const completedChannels = new Set<string>();
  const bundles = new Map<string, JsonRecord>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let terminal = false;
  let expectedIdentity: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    try {
      if (Date.now() - start >= maxTimeMs) throw new Error("Snapshot time budget exhausted");
      const url = new URL(`${towerUrl}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/sync`);
      url.searchParams.set("limit", "2000");
      if (cursor) url.searchParams.set("cursor", cursor);
      const signed = await broker<{ token: string }>("/api/mcp/capabilities/nip98", { url: url.toString(), method: "GET" });
      const response = await boundedFetch(url, { headers: { accept: "application/json", authorization: signed.token, "x-flightdeck-pg-app-npub": appNpub } });
      const payload = record(await response.json());
      rawPages.push(payload);
      if (!response.ok) throw new Error(`Snapshot GET failed (${response.status}): ${String(payload.error ?? response.statusText)}`);
      const pageIdentity = record(payload.identity);
      if (pageIdentity.workspace_id !== workspaceId || pageIdentity.app_npub !== appNpub) throw new Error("Snapshot workspace/app identity mismatch");
      const identityKey = JSON.stringify(Object.entries(pageIdentity).sort());
      if (expectedIdentity && expectedIdentity !== identityKey) throw new Error("Snapshot identity changed between pages");
      expectedIdentity = identityKey;
      if (payload.mode !== "snapshot" || payload.full_snapshot !== true || typeof payload.has_more !== "boolean" || typeof payload.snapshot_complete !== "boolean" || payload.has_more === payload.snapshot_complete) {
        throw new Error("Invalid snapshot completion metadata");
      }
      for (const finding of snapshotSaturation(payload)) {
        saturation.set(`${finding.channelId ?? "workspace"}:${finding.collection}`, finding);
      }
      for (const channel of records(payload.channels)) {
        if (typeof channel.id !== "string") throw new Error("Channel is missing id");
        channels.add(channel.id);
      }
      for (const bundle of records(payload.channel_bundles)) {
        const id = bundle.channel_id;
        if (typeof id !== "string" || !channels.has(id)) throw new Error("Bundle channel is outside visible channel map");
        const merged = bundles.get(id) ?? { channel_id: id };
        for (const [key, value] of Object.entries(bundle)) {
          if (key !== "channel_id") merged[key] = Array.isArray(value) ? mergeRows(merged[key], value) : value;
        }
        bundles.set(id, merged);
      }
      for (const [key, value] of Object.entries(payload)) {
        if (key === "channel_bundles") continue;
        sync[key] = Array.isArray(value) ? mergeRows(sync[key], value) : value;
      }
      sync.channel_bundles = [...bundles.values()];
      if (!payload.has_more && payload.snapshot_complete) {
        terminal = true;
        for (const id of bundles.keys()) completedChannels.add(id);
        break;
      }
      const next = payload.next_cursor;
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("Missing or repeated snapshot cursor");
      // Snapshot cursors are opaque for requests; decode only to report unfinished channels.
      const continuation = record(JSON.parse(Buffer.from(next, "base64url").toString("utf8")));
      if (continuation.kind !== "workspace_snapshot" || continuation.version !== 2 || typeof continuation.channelId !== "string") throw new Error("Invalid snapshot continuation cursor");
      for (const id of bundles.keys()) if (id !== continuation.channelId) completedChannels.add(id);
      cursors.add(next);
      cursor = next;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }
  if (!terminal && !errors.length) errors.push("Snapshot page budget exhausted");
  const missingChannelIds = [...channels].filter(id => !completedChannels.has(id));
  if (terminal && missingChannelIds.length) errors.push("Terminal snapshot omitted visible channel bundles");
  if (saturation.size) errors.push("Possible Tower collection saturation; full coverage cannot be certified");
  const complete = terminal && !errors.length && !missingChannelIds.length;
  const counts: Record<string, number> = {};
  for (const bundle of bundles.values()) for (const [key, value] of Object.entries(bundle)) {
    if (Array.isArray(value)) counts[key] = (counts[key] ?? 0) + value.length;
  }
  return {
    generatedAt: new Date().toISOString(), since: new Date(start - options.hours * 3_600_000).toISOString(),
    recentTriageHours: options.hours, botNpub: identity.botNpub, brokerRequests, complete, errors,
    coverage: { pages: rawPages.length, visibleChannels: channels.size, visitedChannels: bundles.size, completedChannels: completedChannels.size, missingChannels: missingChannelIds.length, channelDirectoryKnown: Boolean(expectedIdentity), missingChannelIds, possibleSaturation: [...saturation.values()], counts },
    workspaces: [{ id: workspaceId, label: typeof workspace.label === "string" ? workspace.label : null, sync }], rawPages,
  };
}
