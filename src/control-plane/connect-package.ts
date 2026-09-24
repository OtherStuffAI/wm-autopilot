import { createHash } from "node:crypto";

import { finalizeEvent, nip19, verifyEvent, type Event } from "nostr-tools";

import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";

export const CONNECT_PACKAGE_KIND = "wingman-autopilot-connect";
export const CONNECT_PACKAGE_VERSION = 1;
export const CONTROL_API_VERSION = "v1";
export const CONNECT_PACKAGE_EVENT_KIND = 30078;
export const DEFAULT_CONNECT_PACKAGE_MAX_AGE_SECONDS = 300;

export const CONTROL_READ_CAPABILITIES = [
  "installation.manifest.read",
  "installation.health.read",
  "agents.discover.read",
  "agents.overview.read",
] as const;

export interface AutopilotConnectPackagePayload {
  kind: typeof CONNECT_PACKAGE_KIND;
  version: typeof CONNECT_PACKAGE_VERSION;
  installationId: string;
  installationNpub: string;
  fipsEndpoint: string;
  httpsEndpoint: string | null;
  generatedAt: string;
  apiVersion: typeof CONTROL_API_VERSION;
  readCapabilities: Array<(typeof CONTROL_READ_CAPABILITIES)[number]>;
}

export interface AutopilotConnectPackage {
  payload: AutopilotConnectPackagePayload;
  signedEvent: Event;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(",")}}`;
  }
  throw new Error("Connect package contains an unsupported value");
}

export function canonicalConnectPackagePayload(payload: AutopilotConnectPackagePayload): string {
  return canonicalValue(payload);
}

export function installationIdForIdentity(identity: Pick<WingmanInstanceIdentity, "pubkeyHex">): string {
  return `autopilot_${createHash("sha256").update(identity.pubkeyHex, "utf8").digest("hex").slice(0, 32)}`;
}

export function createAutopilotConnectPackage(input: {
  identity: WingmanInstanceIdentity;
  fipsEndpoint: string;
  httpsEndpoint?: string | null;
  now?: Date;
}): AutopilotConnectPackage {
  const now = input.now ?? new Date();
  const payload: AutopilotConnectPackagePayload = {
    kind: CONNECT_PACKAGE_KIND,
    version: CONNECT_PACKAGE_VERSION,
    installationId: installationIdForIdentity(input.identity),
    installationNpub: input.identity.npub,
    fipsEndpoint: new URL(input.fipsEndpoint).toString(),
    httpsEndpoint: input.httpsEndpoint ? new URL(input.httpsEndpoint).toString() : null,
    generatedAt: now.toISOString(),
    apiVersion: CONTROL_API_VERSION,
    readCapabilities: [...CONTROL_READ_CAPABILITIES],
  };
  const signedEvent = finalizeEvent({
    kind: CONNECT_PACKAGE_EVENT_KIND,
    created_at: Math.floor(now.getTime() / 1000),
    tags: [["d", payload.installationId], ["version", String(payload.version)]],
    content: canonicalConnectPackagePayload(payload),
  }, input.identity.secretKey);
  return { payload, signedEvent };
}

export function verifyAutopilotConnectPackage(
  input: unknown,
  options: { now?: Date; maxAgeSeconds?: number } = {},
): AutopilotConnectPackage {
  if (!input || typeof input !== "object") throw new Error("Connect package must be an object");
  const candidate = input as Partial<AutopilotConnectPackage>;
  const payload = candidate.payload as AutopilotConnectPackagePayload | undefined;
  const signedEvent = candidate.signedEvent;
  if (!payload || payload.kind !== CONNECT_PACKAGE_KIND) throw new Error("Unsupported connect package kind");
  if (payload.version !== CONNECT_PACKAGE_VERSION) throw new Error("Unsupported connect package version");
  if (!signedEvent || signedEvent.kind !== CONNECT_PACKAGE_EVENT_KIND || !verifyEvent(signedEvent)) {
    throw new Error("Invalid connect package signature");
  }
  if (signedEvent.content !== canonicalConnectPackagePayload(payload)) throw new Error("Connect package payload was tampered with");
  if (nip19.npubEncode(signedEvent.pubkey) !== payload.installationNpub) throw new Error("Connect package signer does not match installation identity");
  const expectedInstallationId = `autopilot_${createHash("sha256").update(signedEvent.pubkey, "utf8").digest("hex").slice(0, 32)}`;
  if (payload.installationId !== expectedInstallationId) throw new Error("Connect package installation ID does not match its signing identity");
  if (signedEvent.tags.find((tag) => tag[0] === "d")?.[1] !== payload.installationId) throw new Error("Connect package installation ID is not signed correctly");
  const generatedAt = Date.parse(payload.generatedAt);
  const now = (options.now ?? new Date()).getTime();
  const maxAgeMs = (options.maxAgeSeconds ?? DEFAULT_CONNECT_PACKAGE_MAX_AGE_SECONDS) * 1000;
  if (!Number.isFinite(generatedAt) || generatedAt > now + 15_000 || now - generatedAt > maxAgeMs) {
    throw new Error("Connect package generation time is invalid or expired");
  }
  if (Math.abs(signedEvent.created_at * 1000 - generatedAt) >= 1000) throw new Error("Connect package generation time is not bound to its signature");
  if (payload.apiVersion !== CONTROL_API_VERSION) throw new Error("Unsupported control API version");
  if (JSON.stringify(payload.readCapabilities) !== JSON.stringify(CONTROL_READ_CAPABILITIES)) {
    throw new Error("Unsupported connect package read capabilities");
  }
  new URL(payload.fipsEndpoint);
  if (payload.httpsEndpoint) new URL(payload.httpsEndpoint);
  return { payload, signedEvent };
}
