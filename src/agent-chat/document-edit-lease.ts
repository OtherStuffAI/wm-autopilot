import { acquireDocumentEditLease } from "../flightdeck-pg/document-edit-lease.ts";
import { parseTowerError, signFlightDeckPgBotRequest } from "./tower-client.ts";
import type { FlightDeckPgBotIdentity } from "./tower-client.ts";
import { fetchTowerRequest } from "./tower-transport-runtime.ts";

/** Use the caller's existing signed Tower transport and error contract. */
export async function acquireNegotiatedDocumentEditLease(context: {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  documentId: string;
  appNpub: string;
  botIdentity: FlightDeckPgBotIdentity;
  signal?: AbortSignal;
  beforeConcurrentAcquire?: () => void;
}): Promise<string> {
  return acquireDocumentEditLease(context.workspaceId, context.documentId, async (method, path, query, body) => {
    const url = new URL(path, context.backendBaseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const authorization = await signFlightDeckPgBotRequest({ ...context, url: url.toString(), method, body });
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "x-flightdeck-pg-app-npub": context.appNpub,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: context.signal,
    };
    const response = "towerTransport" in context.botIdentity && context.botIdentity.towerTransport
      ? await context.botIdentity.towerTransport.fetch(url, init)
      : await fetchTowerRequest(url, init, context);
    if (!response.ok) {
      const error = await parseTowerError(response, method === "GET"
        ? "flightdeck_pg_edit_lease_inspect" : "flightdeck_pg_edit_lease_acquire");
      throw Object.assign(new Error(error.message), error);
    }
    return response.json();
  }, context.beforeConcurrentAcquire);
}
