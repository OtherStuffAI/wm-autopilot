import type { RuntimeBotIdentity } from "./types";
import { signFlightDeckPgBotRequest } from "./tower-client";
import { fetchTowerRequest } from "./tower-transport-runtime";
import { validateNStackSelection, verifiedNStackDescriptor, type NStackWorkspaceConnection } from "./nstack-connect";

export function validateNStackAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a root HTTPS NStack address.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid HTTPS NStack address."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter a root HTTPS NStack address without credentials, path, query or fragment.");
  }
  return url.origin;
}

async function readPage(url: string, identity: RuntimeBotIdentity) {
  const authorization = await signFlightDeckPgBotRequest({ botIdentity: identity, url, method: "GET" });
  const response = await fetchTowerRequest(url, { headers: { Authorization: authorization, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Workspace discovery failed (HTTP ${response.status}). Check the address and local agent membership.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("NStack returned an empty discovery response.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new Error("NStack discovery response is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function discoverNStackWorkspaces(input: {
  address: unknown;
  agentNpubs: string[];
  resolveIdentity: (npub: string) => Promise<RuntimeBotIdentity | null>;
  fetchPage?: (url: string, identity: RuntimeBotIdentity) => Promise<any>;
}) {
  const root = validateNStackAddress(input.address);
  if (!input.agentNpubs.length) throw new Error("Create an enabled local agent and add its public identity to the NStack workspace first.");
  const connections = new Map<string, NStackWorkspaceConnection>();
  const errors: string[] = [];
  let successful = 0;
  for (const npub of new Set(input.agentNpubs)) {
    let identity: RuntimeBotIdentity | null = null;
    try {
      identity = await input.resolveIdentity(npub);
      if (!identity) throw new Error("Local signing identity unavailable.");
      let cursor: string | null = null;
      const cursors = new Set<string>();
      const seen = new Set<string>();
      const discovered: NStackWorkspaceConnection[] = [];
      for (let page = 0; page < 10; page++) {
        const url = new URL("/api/v4/flightdeck-pg/workspaces", root);
        url.searchParams.set("limit", "200");
        if (cursor) url.searchParams.set("cursor", cursor);
        const raw = await (input.fetchPage ?? readPage)(url.href, identity);
        if (!Array.isArray(raw?.workspaces) || raw.workspaces.length > 200) throw new Error("NStack returned invalid workspace discovery data.");
        for (const row of raw.workspaces) {
          const meta = row?.identity;
          const connection = validateNStackSelection([{ name: row?.label, workspaceId: meta?.workspace_id,
            workspaceOwnerNpub: meta?.workspace_owner_npub, workspaceServiceNpub: meta?.workspace_service_npub,
            serviceNpub: meta?.tower_service_npub, directHttpsUrl: root }])[0]!;
          // Bind advertised origins to the address entered, including proxy HTTP normalization.
          verifiedNStackDescriptor(connection, { type: "wingman_workspace_locator", identity: meta, tower_base_url: row.tower_base_url });
          if (seen.has(connection.workspaceId)) throw new Error("NStack returned duplicate workspace identities.");
          seen.add(connection.workspaceId);
          discovered.push(connection);
          if (discovered.length > 1000) throw new Error("NStack returned too many workspaces.");
        }
        cursor = raw.next_cursor ?? null;
        if (cursor === null) break;
        if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || cursors.has(cursor) || page === 9) throw new Error("NStack returned invalid discovery pagination.");
        cursors.add(cursor);
      }
      for (const connection of discovered) {
        const previous = connections.get(connection.workspaceId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(connection)) throw new Error("NStack returned conflicting workspace identities.");
      }
      for (const connection of discovered) connections.set(connection.workspaceId, connection);
      successful++;
    } catch (error) { errors.push(`${npub}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { identity?.botSecret?.fill(0); }
  }
  if (!successful) throw new Error(errors.join("; "));
  return { workspaces: [...connections.values()], errors };
}
