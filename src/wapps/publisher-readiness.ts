import type { WappRecord } from "./types";
import type { WappStore } from "./wapp-store";
import { withManagedPublishingClient } from "./managed-publishing";
import { WappPublishingError, isWappDestinationGranted, type WappPublishingGrant, type WappPublishingFetch } from "./wapp-publishing-client";

export interface PublisherReadinessTarget {
  scope_id: string;
  channel_id: string;
  origin: string;
}

type Check = "passed" | "failed" | "not_checked";

export interface PublisherReadiness {
  ready: boolean;
  code: string;
  installationId: string;
  checkedAt: string;
  grant?: WappPublishingGrant;
  evidence: {
    installationActive: Check;
    noPendingPublisher: Check;
    signingIdentity: Check;
    grantIdentity: Check;
    grantActive: Check;
    capability: Check;
    origin: Check;
    destination: Check;
    configuredPublisherNpub: string | null;
    signingNpub: string | null;
    grantVersion: number | null;
    towerStatus: number | null;
  };
}

export function parsePublisherReadinessTarget(url: URL): PublisherReadinessTarget | null {
  const keys = ["scope_id", "channel_id", "origin"];
  if ([...url.searchParams.keys()].some((key) => !keys.includes(key))) return null;
  if (keys.some((key) => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)?.trim())) return null;
  const origin = url.searchParams.get("origin")!;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return null;
  } catch { return null; }
  return { scope_id: url.searchParams.get("scope_id")!, channel_id: url.searchParams.get("channel_id")!, origin };
}

function publicGrant(grant: WappPublishingGrant): WappPublishingGrant {
  return {
    grant_id: grant.grant_id,
    grant_version: grant.grant_version,
    wapp_installation_id: grant.wapp_installation_id,
    publisher_npub: grant.publisher_npub,
    workspace_id: grant.workspace_id,
    status: grant.status,
    capabilities: grant.capabilities.filter((value) => typeof value === "string"),
    registered_open_origins: grant.registered_open_origins.filter((value) => typeof value === "string"),
    destinations: grant.destinations.filter((value) => value && typeof value.scope_id === "string").map((value) => ({
      scope_id: value.scope_id,
      ...(typeof value.channel_id === "string" ? { channel_id: value.channel_id } : {}),
      ...(Array.isArray(value.channel_ids) ? { channel_ids: value.channel_ids.filter((id) => typeof id === "string") } : {}),
      ...(typeof value.available === "boolean" ? { available: value.available } : {}),
    })),
  };
}

const SAFE_CODES = new Set([
  "publishing_configuration_missing", "publisher_custody_unavailable",
  "publisher_identity_mismatch", "publisher_signature_invalid", "grant_identity_mismatch",
  "grant_not_active", "transport_error", "publisher_not_registered",
  "publishing_grant_disabled", "publishing_grant_revoked", "publishing_grant_not_found", "stale_publisher_key",
]);

export async function checkPublisherReadiness(
  store: WappStore,
  wapp: WappRecord,
  target: PublisherReadinessTarget,
  fetchImpl?: WappPublishingFetch,
): Promise<PublisherReadiness> {
  const evidence: PublisherReadiness["evidence"] = {
    installationActive: "not_checked", noPendingPublisher: "not_checked",
    signingIdentity: "not_checked", grantIdentity: "not_checked", grantActive: "not_checked",
    capability: "not_checked", origin: "not_checked", destination: "not_checked",
    configuredPublisherNpub: wapp.publisherNpub, signingNpub: null, grantVersion: null, towerStatus: null,
  };
  const result: PublisherReadiness = {
    ready: false, code: "readiness_failed", installationId: wapp.wappInstallationId,
    checkedAt: new Date().toISOString(), evidence,
  };
  const fail = (code: string): PublisherReadiness => ({ ...result, code });
  evidence.installationActive = wapp.status === "active" && wapp.recordState === "active" ? "passed" : "failed";
  evidence.noPendingPublisher = wapp.pendingPublisherNpub ? "failed" : "passed";
  if (evidence.installationActive === "failed") return fail("installation_not_active");
  if (evidence.noPendingPublisher === "failed") return fail("publisher_rotation_pending");
  if (target.scope_id !== wapp.scopeId) {
    evidence.destination = "failed";
    return fail("installation_scope_mismatch");
  }
  if (!wapp.registeredOpenOrigins.includes(target.origin)) {
    evidence.origin = "failed";
    return fail("installation_origin_mismatch");
  }
  try {
    return await withManagedPublishingClient(store, wapp, async (client) => {
      try {
        const grant = await client.refreshGrant();
        evidence.grantIdentity = "passed";
        evidence.grantActive = "passed";
        evidence.grantVersion = Number.isSafeInteger(grant.grant_version) ? grant.grant_version : null;
        evidence.capability = Array.isArray(grant.capabilities) && grant.capabilities.includes("activity.publish") ? "passed" : "failed";
        evidence.origin = Array.isArray(grant.registered_open_origins) && grant.registered_open_origins.includes(target.origin) ? "passed" : "failed";
        evidence.destination = isWappDestinationGranted(grant, target.scope_id, target.channel_id) ? "passed" : "failed";
        if (evidence.capability === "failed") return fail("capability_not_granted");
        if (evidence.origin === "failed") return fail("origin_not_granted");
        if (evidence.destination === "failed") return fail("destination_not_granted");
        if (typeof grant.grant_id !== "string" || !grant.grant_id || evidence.grantVersion === null) return fail("grant_invalid");
        return { ...result, ready: true, code: "ready", grant: publicGrant(grant) };
      } finally {
        evidence.signingNpub = client.signingNpub;
        evidence.signingIdentity = client.signingNpub && client.signingNpub === wapp.publisherNpub ? "passed" : "failed";
      }
    }, fetchImpl);
  } catch (error) {
    if (error instanceof WappPublishingError) {
      evidence.towerStatus = error.status;
      if (error.code === "grant_identity_mismatch") evidence.grantIdentity = "failed";
      if (error.code === "grant_not_active") {
        evidence.grantIdentity = "passed";
        evidence.grantActive = "failed";
      }
      if (error.code === "publisher_custody_unavailable") evidence.signingIdentity = "failed";
      return fail(SAFE_CODES.has(error.code) ? error.code : "tower_grant_read_failed");
    }
    return fail("publisher_readiness_failed");
  }
}
