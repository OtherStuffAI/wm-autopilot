import type { RemoteTowerTransport } from "../flightdeck-pg/remote-tower-transport";
import type { WorkspaceSubscriptionManager } from "./subscription-runtime";
import type { RuntimeBotIdentity } from "./types";
import { parsePgWorkspaceDescriptor } from "./pg-workspace-descriptor";
import { normaliseBackendBaseUrl, signFlightDeckPgBotRequest } from "./tower-client";
import { fetchTowerRequest, transportForConnection } from "./tower-transport-runtime";

export interface NStackWorkspaceConnection {
  name: string;
  workspaceId: string;
  workspaceOwnerNpub: string;
  workspaceServiceNpub: string;
  directHttpsUrl: string;
  serviceNpub: string;
}

type DiscoveryIdentity = RuntimeBotIdentity & { towerTransport?: RemoteTowerTransport };

type Manager = Pick<WorkspaceSubscriptionManager,
  "listAgentsForManager" | "listBackendConnectionsForManager" | "listForManager"
  | "importAgentConnectPackage" | "reconnectForManager">;
interface ConnectInput {
  manager: Manager;
  managedByNpub: string;
  workspaces: NStackWorkspaceConnection[];
  resolveIdentity: (npub: string) => Promise<DiscoveryIdentity | null>;
  fetchDescriptor?: typeof fetchDescriptor;
}
const operations = new WeakMap<Manager, Promise<unknown>>();

export function validateNStackSelection(value: unknown): NStackWorkspaceConnection[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) {
    throw new Error("Select between one and 50 workspaces.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid workspace connection.");
    const connection = {} as NStackWorkspaceConnection;
    for (const key of ["name", "workspaceId", "workspaceOwnerNpub", "workspaceServiceNpub", "directHttpsUrl", "serviceNpub"] as const) {
      if (typeof item[key] !== "string" || !item[key].trim() || item[key].length > 2048) {
        throw new Error(`Workspace connection requires ${key}. Refresh NBrowser discovery.`);
      }
      connection[key] = item[key].trim();
    }
    const url = new URL(connection.directHttpsUrl);
    const local = ["localhost", "127.0.0.1", "[::1]", "wingman.local"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("NStack must use a root HTTPS address or approved local HTTP address.");
    }
    connection.directHttpsUrl = normaliseBackendBaseUrl(url.href);
    return connection;
  });
}

async function fetchDescriptor(input: {
  connection: NStackWorkspaceConnection;
  identity: DiscoveryIdentity;
  backendConnectionId?: string;
}) {
  const url = new URL(`/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(input.connection.workspaceId)}/descriptor`, input.connection.directHttpsUrl).href;
  const authorization = await signFlightDeckPgBotRequest({
    botIdentity: input.identity, backendConnectionId: input.backendConnectionId, url, method: "GET",
  });
  const init = { headers: { Authorization: authorization, Accept: "application/json" }, signal: AbortSignal.timeout(15000), redirect: "error" as const };
  const response = "towerTransport" in input.identity && input.identity.towerTransport
    ? await input.identity.towerTransport.fetch(url, init)
    : await fetchTowerRequest(url, init, { backendConnectionId: input.backendConnectionId });
  if (!response.ok) throw new Error(`Workspace descriptor access failed (HTTP ${response.status}). Restore local bot membership or retry connectivity.`);
  return response.json();
}

export function verifiedNStackDescriptor(connection: NStackWorkspaceConnection, raw: unknown) {
  const record = raw as Record<string, unknown>;
  const reported = new URL(String(record?.tower_base_url ?? record?.towerBaseUrl ?? ""));
  const verified = new URL(connection.directHttpsUrl);
  const sameOrigin = reported.origin === verified.origin;
  const proxyHttp = verified.protocol === "https:" && reported.protocol === "http:"
    && reported.hostname === verified.hostname && !verified.port && !reported.port;
  if ((!sameOrigin && !proxyHttp) || reported.pathname !== "/" || reported.search || reported.hash || reported.username || reported.password) {
    throw new Error("Tower descriptor address differs from the verified NStack origin.");
  }
  // A proxy may advertise HTTP. Retain the exact verified HTTPS origin; never follow its replacement.
  const normalized = { ...record, tower_base_url: connection.directHttpsUrl };
  const descriptor = parsePgWorkspaceDescriptor(normalized);
  if (descriptor.towerBaseUrl !== connection.directHttpsUrl
    || descriptor.towerServiceNpub !== connection.serviceNpub
    || descriptor.workspaceId !== connection.workspaceId
    || descriptor.workspaceOwnerNpub !== connection.workspaceOwnerNpub
    || descriptor.workspaceServiceNpub !== connection.workspaceServiceNpub || !descriptor.appNpub) {
    throw new Error("Tower workspace identity does not match the disclosed connection. Refresh discovery.");
  }
  return { descriptor, raw: normalized };
}

// Serialize setup on this instance: simultaneous browser retries must not race subscription creation.
export async function connectNStackWorkspaces(input: ConnectInput) {
  const previous = operations.get(input.manager) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => connectSelected(input));
  operations.set(input.manager, operation);
  try { return await operation; }
  finally { if (operations.get(input.manager) === operation) operations.delete(input.manager); }
}

async function connectSelected(input: ConnectInput) {
  const workspaces = validateNStackSelection(input.workspaces);
  const results = [];
  const seen = new Set<string>();
  for (const connection of workspaces) {
    const key = JSON.stringify([connection.directHttpsUrl, connection.serviceNpub, connection.workspaceId, connection.workspaceServiceNpub]);
    if (seen.has(key)) continue;
    seen.add(key);
    const subscriptionIds: string[] = [];
    const errors = [];
    let verified = 0;
    let preserved = 0;
    try {
      const backend = input.manager.listBackendConnectionsForManager(input.managedByNpub)
        .find((row) => normaliseBackendBaseUrl(row.backendBaseUrl) === connection.directHttpsUrl && row.serviceNpub === connection.serviceNpub);
      const agents = input.manager.listAgentsForManager(input.managedByNpub).filter((agent) => agent.enabled && !agent.archived);
      if (!agents.length) throw new Error("No enabled local agents. Create a local agent and add its public identity to the workspace first.");
      for (const agent of agents) {
        let identity: DiscoveryIdentity | null;
        try { identity = await input.resolveIdentity(agent.botNpub); }
        catch (error) { errors.push(`${agent.label}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        if (!identity) { errors.push(`${agent.label}: local signing identity unavailable`); continue; }
        try {
          if (backend) identity.towerTransport = {
            prepare: async (url) => (await transportForConnection(backend).prepare(url)).href,
            fetch: (url, init) => transportForConnection(backend).fetch(url, init),
          };
          const raw = await (input.fetchDescriptor ?? fetchDescriptor)({ connection, identity, backendConnectionId: backend?.backendConnectionId });
          const validated = verifiedNStackDescriptor(connection, raw);
          const descriptor = validated.descriptor;
          verified++;
          const existing = input.manager.listForManager(input.managedByNpub).find((row) =>
            normaliseBackendBaseUrl(row.backendBaseUrl) === connection.directHttpsUrl
            && row.workspaceId === descriptor.workspaceId && row.sourceAppNpub === descriptor.appNpub
            && (row.botNpub === agent.botNpub || !row.agentProfileId));
          if (existing) {
            if (!subscriptionIds.includes(existing.subscriptionId)) subscriptionIds.push(existing.subscriptionId);
            if (existing.lifecycleStatus !== "active" || existing.sseStatus === "disabled") { preserved++; continue; }
            if (existing.healthStatus !== "healthy") await input.manager.reconnectForManager(existing.subscriptionId, input.managedByNpub);
          } else {
            const imported = await input.manager.importAgentConnectPackage({
              managedByNpub: input.managedByNpub, agentProfileId: agent.agentId,
              packageJson: {
                kind: "coworker_agent_connect", version: 6, protocol: "flightdeck_pg",
                generated_at: new Date().toISOString(),
                service: { direct_https_url: connection.directHttpsUrl, service_npub: descriptor.towerServiceNpub },
                workspace_descriptor: validated.raw,
              },
            });
            subscriptionIds.push(imported.subscription.subscriptionId);
          }
        } catch (error) { errors.push(`${agent.label}: ${error instanceof Error ? error.message : String(error)}`); }
        finally { identity.botSecret?.fill(0); }
      }
      if (!subscriptionIds.length) throw new Error(errors.join("; ") || "No authorized local agent could connect.");
      const records = input.manager.listForManager(input.managedByNpub).filter((row) => subscriptionIds.includes(row.subscriptionId));
      const attention = records.some((row) => row.lastErrorCode || row.healthStatus !== "healthy");
      results.push({ key, name: connection.name, workspaceId: connection.workspaceId, subscriptionIds,
        status: preserved ? "preserved" : attention ? "needs_attention" : "monitoring",
        message: preserved ? "Existing paused, revoked or disconnected subscriptions preserved. Use connection controls to resume."
          : attention ? "Saved; connection recovery is active. See workspace diagnostics."
            : "Monitoring workspace events. Agents run only when addressed and authorized.",
        verifiedAgents: verified, errors });
    } catch (error) {
      results.push({ key, name: connection.name, workspaceId: connection.workspaceId, subscriptionIds,
        status: "failed", message: error instanceof Error ? error.message : String(error), errors });
    }
  }
  return { results };
}
