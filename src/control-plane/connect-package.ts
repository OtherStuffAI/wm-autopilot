import { createHash } from "node:crypto";

import { finalizeEvent, nip19, verifyEvent } from "nostr-tools";

import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { AutopilotConnectManifestV1, AutopilotConnectPackageV1 } from "./contracts";

export const CONNECT_PACKAGE_KIND = "wingman_autopilot_connect";
export const CONNECT_PACKAGE_VERSION = 1;
export const CONTROL_API_VERSION = 1;
export const CONNECT_PACKAGE_EVENT_KIND = 27236;
export const DEFAULT_CONNECT_PACKAGE_MAX_AGE_SECONDS = 300;
export const CONTROL_READ_CAPABILITIES = ["health", "agents.read"] as const;

const SECRET_KEY_PATTERN = /(^|_)(nsec|secret|private_key|bearer|token|bunker_uri|nwc|wallet_connect)(_|$)/i;
const SECRET_VALUE_PATTERN = /^(nsec1|nostr\+walletconnect:|nostrconnect:|bunker:)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  throw new Error("Connect package contains an unsupported value");
}

function assertNoSecrets(value: unknown, path = "package"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value.trim())) {
      throw new Error(`Connect package contains forbidden secret material at ${path}`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new Error(`Connect package contains forbidden credential field ${path}.${key}`);
    assertNoSecrets(entry, `${path}.${key}`);
  }
}

function exactFipsOrigin(value: string, installationNpub: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== `${installationNpub}.fips` || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Connect package FIPS endpoint must match the installation identity exactly");
  }
  return endpoint.origin;
}

function exactAdvertisedPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("#")) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

export function canonicalConnectManifest(manifest: AutopilotConnectManifestV1): string {
  return canonicalValue(manifest);
}

export function installationIdForIdentity(identity: Pick<WingmanInstanceIdentity, "pubkeyHex">): string {
  return `autopilot_${createHash("sha256").update(identity.pubkeyHex, "utf8").digest("hex").slice(0, 32)}`;
}

export function createAutopilotConnectPackage(input: {
  identity: WingmanInstanceIdentity;
  fipsEndpoint: string;
  ownerNpub: string;
  httpsEndpoint?: string | null;
  now?: Date;
}): AutopilotConnectPackageV1 {
  const now = input.now ?? new Date();
  const installationId = installationIdForIdentity(input.identity);
  const ownerSegment = encodeURIComponent(input.ownerNpub);
  const manifest: AutopilotConnectManifestV1 = {
    kind: CONNECT_PACKAGE_KIND,
    version: CONNECT_PACKAGE_VERSION,
    generated_at: now.toISOString(),
    installation: { id: installationId, npub: input.identity.npub },
    endpoints: {
      fips: exactFipsOrigin(input.fipsEndpoint, input.identity.npub),
      https: input.httpsEndpoint ? new URL(input.httpsEndpoint).origin : null,
    },
    api: {
      version: CONTROL_API_VERSION,
      capabilities: [...CONTROL_READ_CAPABILITIES],
      health_path: `/api/owners/${ownerSegment}/control-plane/v1/health`,
      agents_path: `/api/owners/${ownerSegment}/control-plane/v1/agents`,
    },
  };
  const signature = finalizeEvent({
    kind: CONNECT_PACKAGE_EVENT_KIND,
    created_at: Math.floor(now.getTime() / 1000),
    tags: [["d", installationId]],
    content: canonicalConnectManifest(manifest),
  }, input.identity.secretKey);
  return { manifest, signature };
}

export function verifyAutopilotConnectPackage(
  input: unknown,
  options: { now?: Date; maxAgeSeconds?: number } = {},
): AutopilotConnectPackageV1 {
  assertNoSecrets(input);
  if (!isPlainObject(input) || !isPlainObject(input.manifest) || !isPlainObject(input.signature)) {
    throw new Error("Connect package requires manifest and signature objects");
  }
  const candidate = input as unknown as AutopilotConnectPackageV1;
  const { manifest, signature } = candidate;
  if (manifest.kind !== CONNECT_PACKAGE_KIND) throw new Error("Unsupported connect package kind");
  if (manifest.version !== CONNECT_PACKAGE_VERSION) throw new Error("Unsupported connect package version");
  if (signature.kind !== CONNECT_PACKAGE_EVENT_KIND || !verifyEvent(signature)) throw new Error("Invalid connect package signature");
  if (signature.content !== canonicalConnectManifest(manifest)) throw new Error("Connect package manifest was tampered with");
  let installationPubkey: string;
  try {
    const decoded = nip19.decode(manifest.installation.npub);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") throw new Error("not npub");
    installationPubkey = decoded.data;
  } catch {
    throw new Error("Connect package installation identity is invalid");
  }
  if (signature.pubkey !== installationPubkey) throw new Error("Connect package signer does not match installation identity");
  const expectedInstallationId = `autopilot_${createHash("sha256").update(signature.pubkey, "utf8").digest("hex").slice(0, 32)}`;
  if (manifest.installation.id !== expectedInstallationId) throw new Error("Connect package installation ID does not match its signing identity");
  if (signature.tags.find((tag) => tag[0] === "d")?.[1] !== manifest.installation.id) throw new Error("Connect package installation ID is not signed correctly");
  const generatedAt = Date.parse(manifest.generated_at);
  const now = (options.now ?? new Date()).getTime();
  const maxAgeMs = (options.maxAgeSeconds ?? DEFAULT_CONNECT_PACKAGE_MAX_AGE_SECONDS) * 1000;
  if (!Number.isFinite(generatedAt) || generatedAt > now + 15_000 || now - generatedAt > maxAgeMs) {
    throw new Error("Connect package generation time is invalid or expired");
  }
  if (Math.abs(signature.created_at * 1000 - generatedAt) >= 1000) throw new Error("Connect package generation time is not bound to its signature");
  if (manifest.api.version !== CONTROL_API_VERSION) throw new Error("Unsupported control API version");
  if (!Array.isArray(manifest.api.capabilities)) throw new Error("Connect package capabilities are invalid");
  exactAdvertisedPath(manifest.api.health_path, "Health route");
  exactAdvertisedPath(manifest.api.agents_path, "Agents route");
  exactFipsOrigin(manifest.endpoints.fips, manifest.installation.npub);
  if (manifest.endpoints.https) new URL(manifest.endpoints.https);
  return candidate;
}
