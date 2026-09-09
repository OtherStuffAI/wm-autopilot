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

async function lookup(input: string | URL): Promise<TowerTransport | null> {
  const url = new URL(input);
  const { backendConnectionStore } = await import("./backend-connection-store");
  const matches = backendConnectionStore.listAll().filter((record) => {
    const config = normalizeTowerTransport(record.transport, record.backendBaseUrl);
    return [record.backendBaseUrl, config.httpsEndpoint, config.fipsEndpoint]
      .some((endpoint) => endpoint && new URL(endpoint).origin === url.origin);
  });
  const configurations = new Set(matches.map((record) => JSON.stringify(normalizeTowerTransport(record.transport, record.backendBaseUrl))));
  if (configurations.size > 1) throw new Error("Tower origin has conflicting connection transport approvals; resolve connection settings before use");
  if (!matches.length) {
    if (url.hostname.endsWith(".fips")) throw new Error("FIPS destination has no approved Tower connection");
    return null;
  }
  return transportForConnection(matches[0]!);
}

export async function prepareTowerRequestUrl(input: string | URL): Promise<string> {
  const transport = await lookup(input);
  return transport ? (await transport.prepare(input)).toString() : input.toString();
}

export async function fetchTowerRequest(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const transport = await lookup(input);
  if (!transport) return fetch(input, init);
  const actual = transport.target(input).toString();
  if (transport.config.mode === "fips") {
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
