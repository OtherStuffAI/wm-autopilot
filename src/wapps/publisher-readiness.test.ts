import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generateSecretKey, nip19, verifyEvent } from "nostr-tools";
import { WappStore } from "./wapp-store";
import { checkPublisherReadiness, parsePublisherReadinessTarget } from "./publisher-readiness";
import type { WappPublishingFetch } from "./wapp-publishing-client";

const target = { scope_id: "scope-1", channel_id: "channel-1", origin: "https://book.example" };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "publisher-readiness-"));
  const store = new WappStore(join(dir, "wapps.sqlite"));
  const binding = store.createTowerBinding({
    label: "Tower", towerUrl: "https://tower.example", workspaceId: "workspace-1", workspaceOwnerNpub: "npub1owner",
  });
  const wapp = store.create({
    appId: "app-1", title: "Book of Sand", ownerNpub: "npub1owner", createdByNpub: "npub1owner",
    workspaceOwnerNpub: "npub1owner", scopeId: target.scope_id, allowedNpubs: ["npub1owner"],
    launchUrl: target.origin, registeredOpenOrigins: [target.origin], towerBindingId: binding.id, appKeyMode: "generate",
  });
  const grant = {
    grant_id: "grant-1", grant_version: 1, wapp_installation_id: wapp.id,
    publisher_npub: wapp.publisherNpub, workspace_id: binding.workspaceId, status: "active",
    capabilities: ["activity.publish"], registered_open_origins: [target.origin],
    destinations: [{ scope_id: target.scope_id, channel_ids: [target.channel_id] }],
  };
  const calls: Request[] = [];
  const fetchImpl: WappPublishingFetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://tower.example/api/v4/wapp-activity/workspaces/workspace-1/grants/me");
    expect(request.redirect).toBe("error");
    expect(request.body).toBeNull();
    const event = JSON.parse(Buffer.from(request.headers.get("authorization")!.slice(6), "base64").toString());
    expect(verifyEvent(event)).toBe(true);
    expect(nip19.npubEncode(event.pubkey)).toBe(wapp.publisherNpub!);
    expect(event.kind).toBe(27235);
    expect(event.tags).toEqual([["u", request.url], ["method", "GET"]]);
    return Response.json({ grant });
  };
  return { store, wapp, grant, calls, fetchImpl, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("publisher readiness", () => {
  test("proves actual protected-custody signing with only a publisher grant GET", async () => {
    const f = fixture();
    try {
      const before = f.store.get(f.wapp.id);
      Object.assign(f.grant, { token: "private-token", nsec: "private-key", nested: { secret: "private" } });
      Object.assign(f.grant.destinations[0]!, { token: "destination-secret", available: true });
      // A presence flag is neither necessary nor sufficient proof of usable signing custody.
      f.store.hasAppSigningKey = () => false;
      const result = await checkPublisherReadiness(f.store, f.wapp, target, f.fetchImpl);
      expect(result.ready).toBe(true);
      expect(result.code).toBe("ready");
      expect(result.grant).toEqual({
        grant_id: "grant-1", grant_version: 1, wapp_installation_id: f.wapp.id,
        publisher_npub: f.wapp.publisherNpub, workspace_id: "workspace-1", status: "active",
        capabilities: ["activity.publish"], registered_open_origins: [target.origin],
        destinations: [{ scope_id: target.scope_id, channel_ids: [target.channel_id], available: true }],
      });
      expect(result.evidence.signingNpub).toBe(f.wapp.publisherNpub);
      for (const key of ["installationActive", "noPendingPublisher", "signingIdentity", "grantIdentity", "grantActive", "capability", "origin", "destination"] as const) {
        expect(result.evidence[key]).toBe("passed");
      }
      expect(f.calls).toHaveLength(1);
      expect(f.store.get(f.wapp.id)).toEqual(before);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("nsec1");
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain("destination-secret");
      expect(serialized).not.toContain("Nostr ");
      expect(serialized).not.toContain('"sig"');
    } finally { f.cleanup(); }
  });

  test("reports missing or unreadable custody without leaking vault errors", async () => {
    const f = fixture();
    try {
      f.store.hasAppSigningKey = () => true;
      f.store.withAppSigningKey = async () => { throw new Error("secret vault details nsec1sensitive"); };
      const result = await checkPublisherReadiness(f.store, f.wapp, target, f.fetchImpl);
      expect(result.code).toBe("publisher_custody_unavailable");
      expect(result.ready).toBe(false);
      expect(result.evidence.signingIdentity).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test("rejects actual signing identity drift before making a Tower request", async () => {
    const f = fixture();
    try {
      f.store.withAppSigningKey = async (_id, operation) => await operation(nip19.nsecEncode(generateSecretKey()));
      const result = await checkPublisherReadiness(f.store, f.wapp, target, f.fetchImpl);
      expect(result.code).toBe("publisher_identity_mismatch");
      expect(result.evidence.signingIdentity).toBe("failed");
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  for (const [change, code] of [
    [{ pendingPublisherNpub: "npub1pending" }, "publisher_rotation_pending"],
    [{ status: "archived" as const }, "installation_not_active"],
    [{ recordState: "deleted" as const }, "installation_not_active"],
    [{ towerBindingId: null }, "publishing_configuration_missing"],
  ] as const) {
    test(`rejects local state: ${code}`, async () => {
      const f = fixture();
      try {
        const result = await checkPublisherReadiness(f.store, { ...f.wapp, ...change }, target, f.fetchImpl);
        expect(result.code).toBe(code);
        expect(result.ready).toBe(false);
        expect(f.calls).toHaveLength(0);
      } finally { f.cleanup(); }
    });
  }

  for (const [change, code] of [
    [{ status: "revoked" }, "grant_not_active"],
    [{ status: "disabled" }, "grant_not_active"],
    [{ publisher_npub: "npub1other" }, "grant_identity_mismatch"],
    [{ wapp_installation_id: "other-installation" }, "grant_identity_mismatch"],
    [{ workspace_id: "other-workspace" }, "grant_identity_mismatch"],
    [{ capabilities: [] }, "capability_not_granted"],
    [{ capabilities: null }, "capability_not_granted"],
    [{ registered_open_origins: ["https://other.example"] }, "origin_not_granted"],
    [{ destinations: [{ scope_id: "scope-1", channel_ids: ["other-channel"] }] }, "destination_not_granted"],
    [{ destinations: null }, "destination_not_granted"],
    [{ destinations: [{ scope_id: "scope-1", channel_ids: ["channel-1"], available: false }] }, "destination_not_granted"],
    [{ destinations: [{ scope_id: "scope-1", channel_id: "channel-1", available: false }] }, "destination_not_granted"],
    [{ grant_version: null }, "grant_invalid"],
  ] as const) {
    test(`rejects authoritative grant: ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      try {
        Object.assign(f.grant, change);
        const result = await checkPublisherReadiness(f.store, f.wapp, target, f.fetchImpl);
        expect(result.code).toBe(code);
        expect(result.ready).toBe(false);
        expect(result.evidence.signingIdentity).toBe("passed");
        expect(f.calls).toHaveLength(1);
      } finally { f.cleanup(); }
    });
  }

  test("sanitizes untrusted Tower errors and exposes transport failure", async () => {
    const f = fixture();
    try {
      const result = await checkPublisherReadiness(f.store, f.wapp, target, async () => Response.json({ error: "nsec1sensitive" }, { status: 500 }));
      expect(result.code).toBe("tower_grant_read_failed");
      expect(result.evidence.towerStatus).toBe(500);
      expect(JSON.stringify(result)).not.toContain("sensitive");
      const offline = await checkPublisherReadiness(f.store, f.wapp, target, async () => { throw new Error("private details"); });
      expect(offline.code).toBe("transport_error");
    } finally { f.cleanup(); }
  });

  test("requires an exact explicit target without proxy or duplicate parameters", () => {
    const url = new URL("https://autopilot.example/api/wapps/id/publisher-readiness");
    expect(parsePublisherReadinessTarget(url)).toBeNull();
    url.search = new URLSearchParams(target).toString();
    expect(parsePublisherReadinessTarget(url)).toEqual(target);
    for (const suffix of ["&scope_id=other", "&tower_url=https://evil.example", "&origin=https://evil.example"]) {
      expect(parsePublisherReadinessTarget(new URL(`${url}${suffix}`))).toBeNull();
    }
    url.searchParams.set("origin", "https://book.example/path");
    expect(parsePublisherReadinessTarget(url)).toBeNull();
  });
});
