import { resolveTowerRequestConnection, type TowerRequestContext } from "./tower-request-context";
export type { TowerRequestContext } from "./tower-request-context";
import { TowerTransport } from "./tower-transport";
import { normalizeTowerTransport } from "./tower-transport-config";
import type { BackendConnectionRecord } from "./types";

const transports = new Map<string, { fingerprint: string; transport: TowerTransport }>();

export function transportForConnection(record: BackendConnectionRecord): TowerTransport {
  const config = normalizeTowerTransport(record.transport, record.backendBaseUrl);
  const fingerprint = JSON.stringify([record.backendBaseUrl, config]);
  const previous = transports.get(record.backendConnectionId);
  if (previous?.fingerprint === fingerprint) return previous.transport;
  previous?.transport.close();
  const transport = new TowerTransport(record.backendBaseUrl, config);
  transports.set(record.backendConnectionId, { fingerprint, transport });
  return transport;
}

async function lookup(input: string | URL, context: TowerRequestContext): Promise<TowerTransport | null> {
  const url = new URL(input);
  if (!context.backendConnectionId && !context.subscriptionId) {
    if (url.hostname.endsWith(".fips")) throw new Error("FIPS destination has no approved Tower connection");
    return null;
  }
  const [{ backendConnectionStore }, { workspaceSubscriptionStore }] = await Promise.all([
    import("./backend-connection-store"), import("./workspace-subscription-store"),
  ]);
  const record = resolveTowerRequestConnection(context, {
    connection: (id) => backendConnectionStore.getById(id),
    subscription: (id) => workspaceSubscriptionStore.getBySubscriptionId(id),
  });
  if (!record) {
    if (url.hostname.endsWith(".fips")) throw new Error("FIPS destination has no approved Tower connection");
    return null;
  }
  const transport = transportForConnection(record);
  transport.target(url);
  return transport;
}

export async function prepareTowerRequestUrl(input: string | URL, context: TowerRequestContext = {}): Promise<string> {
  const transport = await lookup(input, context);
  return transport ? (await transport.prepare(input)).toString() : input.toString();
}

export async function fetchTowerRequest(input: string | URL, init: RequestInit = {}, context: TowerRequestContext = {}): Promise<Response> {
  const transport = await lookup(input, context);
  if (!transport) return fetch(input, init);
  const actual = transport.target(input).toString();
  {
    const auth = new Headers(init.headers).get("authorization");
    if (auth) {
      let target: unknown;
      try {
        const event = JSON.parse(Buffer.from(auth.replace(/^Nostr\s+/i, ""), "base64").toString());
        target = event.tags.find((tag: unknown[]) => tag[0] === "u")?.[1];
      } catch { throw new Error("Invalid NIP-98 authorization for Tower FIPS request"); }
      if (target !== actual) throw new Error("Tower transport changed or NIP-98 target differs from approved request");
    }
  }
  return transport.fetch(input, init);
}
