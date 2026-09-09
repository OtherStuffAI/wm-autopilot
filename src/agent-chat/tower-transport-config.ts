import { nip19 } from "nostr-tools";

export interface TowerTransportConfig {
  mode: "https" | "fips";
  httpsEndpoint: string | null;
  fipsEndpoint: string | null;
  expectedServiceNpub: string | null;
}

export function validateServiceNpub(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected Tower service npub is required");
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub" && decoded.data.length === 64 && nip19.npubEncode(decoded.data) === value) return value;
  } catch {}
  throw new Error("Expected Tower service npub must be a canonical checksummed npub");
}

export function parseTowerFipsEndpoint(value: unknown): { endpoint: string; nodeNpub: string; port: number } {
  if (typeof value !== "string") throw new Error("Approved FIPS endpoint is required");
  const match = /^http:\/\/(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})\.fips:([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match || Number(match[2]) > 65535 || Number(match[2]) === 80) {
    throw new Error("FIPS endpoint must be http://<checksummed-node-npub>.fips:<port> (1–65535 except 80), without credentials, path, query or fragment");
  }
  const nodeNpub = validateServiceNpub(match[1]);
  return { endpoint: value.replace(/\/$/, ""), nodeNpub, port: Number(match[2]) };
}

export function normalizeTowerTransport(value: unknown, legacyEndpoint: string): TowerTransportConfig {
  if (value == null) return { mode: "https", httpsEndpoint: legacyEndpoint, fipsEndpoint: null, expectedServiceNpub: null };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Tower transport configuration");
  const input = value as Record<string, unknown>;
  if (input.mode !== "https" && input.mode !== "fips") throw new Error("Tower transport must be https or fips");
  let httpsEndpoint: string | null = null;
  if (input.httpsEndpoint != null) {
    if (typeof input.httpsEndpoint !== "string") throw new Error("Invalid HTTPS endpoint");
    const url = new URL(input.httpsEndpoint);
    // Preserve existing local HTTP installations during migration.
    if (!["http:", "https:"].includes(url.protocol) || url.hostname.endsWith(".fips") || url.username || url.password || url.search || url.hash) throw new Error("Invalid HTTPS endpoint");
    httpsEndpoint = input.httpsEndpoint.replace(/\/+$/, "");
  }
  const fipsEndpoint = input.fipsEndpoint == null ? null : parseTowerFipsEndpoint(input.fipsEndpoint).endpoint;
  const expectedServiceNpub = input.expectedServiceNpub == null ? null : validateServiceNpub(input.expectedServiceNpub);
  if (input.mode === "https" && !httpsEndpoint) throw new Error("HTTPS selection requires an endpoint");
  if (input.mode === "fips" && (!fipsEndpoint || !expectedServiceNpub)) throw new Error("FIPS selection requires an approved endpoint and expected Tower service npub");
  return { mode: input.mode, httpsEndpoint, fipsEndpoint, expectedServiceNpub };
}

export function effectiveTowerEndpoint(config: TowerTransportConfig): string {
  const endpoint = config.mode === "fips" ? config.fipsEndpoint : config.httpsEndpoint;
  if (!endpoint) throw new Error(`Selected ${config.mode} endpoint is missing`);
  return endpoint;
}
