import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";

import {
  createWappNip98Authorization,
  WappPublishingClient,
  WappPublishingError,
  TowerWappActivityRoutes,
  type WappActivityProjection,
  type WappPublishingRouteAdapter,
} from "./wapp-publishing-client";

const secret = generateSecretKey();
const nsec = nip19.nsecEncode(secret);
const publisherNpub = nip19.npubEncode(getPublicKey(secret));
const routes: WappPublishingRouteAdapter = {
  grantUrl: (towerUrl, workspaceId) => `${towerUrl}/runtime/${workspaceId}/grant`,
  publicationUrl: (towerUrl, workspaceId) => `${towerUrl}/runtime/${workspaceId}/items`,
  classifyError: ({ status, code }) => {
    if (["grant_revoked", "stale_grant"].includes(code)) return "refresh_grant";
    if (status === 429 || status >= 500) return "retryable";
    return "permanent";
  },
};
const projection: WappActivityProjection = {
  external_id: "lead-1",
  version: 1,
  scope_id: "scope-1",
  channel_id: "channel-1",
  category: "lead",
  title: "New lead",
  summary: "Review the lead",
  occurred_at: "2026-08-03T00:00:00.000Z",
  priority: "normal",
  state: "active",
  open_url: "https://wapp.example/leads/1",
};

function grant() {
  return {
    grant_id: "grant-1",
    wapp_installation_id: "installation-1",
    publisher_npub: publisherNpub,
    workspace_id: "workspace-1",
    capabilities: ["activity.publish"],
    destinations: [{ scope_id: "scope-1", channel_ids: ["channel-1"] }],
    registered_open_origins: ["https://wapp.example"],
    grant_version: 3,
    status: "active",
  };
}

function decodeAuthorization(value: string) {
  const event = JSON.parse(Buffer.from(value.slice("Nostr ".length), "base64").toString("utf8"));
  expect(verifyEvent(event)).toBe(true);
  return event as { pubkey: string; kind: number; tags: string[][] };
}

describe("WApp publishing client", () => {
  test("uses the Tower as-built publisher routes and error policy", () => {
    expect(TowerWappActivityRoutes.grantUrl("https://tower.example/base", "workspace/1"))
      .toBe("https://tower.example/api/v4/wapp-activity/workspaces/workspace%2F1/grants/me");
    expect(TowerWappActivityRoutes.publicationUrl("https://tower.example", "workspace-1"))
      .toBe("https://tower.example/api/v4/wapp-activity/workspaces/workspace-1/items");
    expect(TowerWappActivityRoutes.classifyError({ status: 403, code: "publishing_grant_revoked" })).toBe("refresh_grant");
    expect(TowerWappActivityRoutes.classifyError({ status: 422, code: "validation_failed" })).toBe("permanent");
    expect(TowerWappActivityRoutes.classifyError({ status: 429, code: "rate_limited" })).toBe("retryable");
  });

  test("signs the exact URL, method, and serialized payload hash", () => {
    const serialized = JSON.stringify(projection);
    const event = decodeAuthorization(createWappNip98Authorization({
      url: "https://tower.example/exact?value=1",
      method: "POST",
      nsec,
      serializedBody: serialized,
      createdAt: 1_786_000_000,
    }));
    expect(event.kind).toBe(27235);
    expect(event.pubkey).toBe(getPublicKey(secret));
    expect(event.tags).toContainEqual(["u", "https://tower.example/exact?value=1"]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual([
      "payload",
      createHash("sha256").update(serialized, "utf8").digest("hex"),
    ]);
  });

  test("caches the self grant version and ETag", async () => {
    const requests: Request[] = [];
    const client = new WappPublishingClient({
      towerUrl: "https://tower.example",
      workspaceId: "workspace-1",
      wappInstallationId: "installation-1",
      publisherNpub,
      nsec,
      routes,
      fetchImpl: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
        requests.push(request);
        if (requests.length === 1) {
          return Response.json({ grant: grant() }, { headers: { ETag: '"grant-v3"' } });
        }
        return new Response(null, { status: 304 });
      },
    });

    expect((await client.refreshGrant()).grant_version).toBe(3);
    expect((await client.refreshGrant()).grant_version).toBe(3);
    expect(requests[1]?.headers.get("if-none-match")).toBe('"grant-v3"');
    expect(client.cachedGrantEtag).toBe('"grant-v3"');
  });

  test("refreshes on startup and through the periodic scheduler", async () => {
    const scheduledRefreshes: Array<() => void> = [];
    let grantReads = 0;
    const client = new WappPublishingClient({
      towerUrl: "https://tower.example",
      workspaceId: "workspace-1",
      wappInstallationId: "installation-1",
      publisherNpub,
      nsec,
      routes,
      refreshIntervalMs: 60_000,
      refreshScheduler: (refresh, intervalMs) => {
        expect(intervalMs).toBe(60_000);
        scheduledRefreshes.push(refresh);
        return () => { scheduledRefreshes.length = 0; };
      },
      fetchImpl: async () => {
        grantReads += 1;
        return Response.json({ grant: grant() });
      },
    });
    await client.start();
    expect(grantReads).toBe(1);
    scheduledRefreshes[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(grantReads).toBe(2);
    client.stop();
    expect(scheduledRefreshes).toHaveLength(0);
  });

  test("retries retryable publication with the identical business payload", async () => {
    const publicationBodies: string[] = [];
    const delays: number[] = [];
    let publications = 0;
    const client = new WappPublishingClient({
      towerUrl: "https://tower.example",
      workspaceId: "workspace-1",
      wappInstallationId: "installation-1",
      publisherNpub,
      nsec,
      routes,
      retryBaseMs: 10,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      fetchImpl: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
        if (request.method === "GET") return Response.json({ grant: grant() });
        publicationBodies.push(await request.text());
        publications += 1;
        return publications === 1
          ? Response.json({ error: "rate_limited" }, { status: 429 })
          : Response.json({ item: { id: "item-1" } });
      },
    });

    expect(await client.publish(projection)).toEqual({ item: { id: "item-1" } });
    expect(publicationBodies).toEqual([JSON.stringify(projection), JSON.stringify(projection)]);
    expect(delays).toEqual([10]);
  });

  test("refreshes after stable stale errors and redacts authorization material", async () => {
    let grantReads = 0;
    const client = new WappPublishingClient({
      towerUrl: "https://tower.example",
      workspaceId: "workspace-1",
      wappInstallationId: "installation-1",
      publisherNpub,
      nsec,
      routes,
      fetchImpl: async (_input, init) => {
        if (init?.method === "GET") {
          grantReads += 1;
          return Response.json({ grant: grant() }, { headers: { ETag: `"grant-v${grantReads}"` } });
        }
        return Response.json({ error: "stale_grant", unsafe: nsec }, { status: 409 });
      },
    });

    await expect(client.publish(projection)).rejects.toBeInstanceOf(WappPublishingError);
    expect(grantReads).toBe(2);
    try {
      await client.publish(projection);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(nsec);
      expect((error as Error).message).not.toContain("unsafe");
    }
  });

  test("rejects grants for a different installation", async () => {
    const client = new WappPublishingClient({
      towerUrl: "https://tower.example",
      workspaceId: "workspace-1",
      wappInstallationId: "installation-1",
      publisherNpub,
      nsec,
      routes,
      fetchImpl: async () => Response.json({ grant: { ...grant(), wapp_installation_id: "other" } }),
    });
    await expect(client.refreshGrant()).rejects.toMatchObject({ code: "grant_identity_mismatch" });
    expect(JSON.stringify(client)).not.toContain(nsec);
  });
});
