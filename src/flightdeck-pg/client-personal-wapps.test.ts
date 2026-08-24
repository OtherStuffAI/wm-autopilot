import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateSecretKey } from "nostr-tools";

import { createBotIdentityFromCapability, createBotIdentityFromSecret, FlightDeckPgClient } from "./client";

describe("FlightDeckPgClient personal WApp routes", () => {
  test("signs list, create, update, and archive requests against typed Tower routes", async () => {
    const requests: Request[] = [];
    const client = new FlightDeckPgClient({
      towerUrl: "https://tower.example",
      wingmanUrl: "",
      appNpub: "npub1flightdeck",
      botIdentity: createBotIdentityFromSecret(generateSecretKey()),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
        requests.push(request);
        return Response.json(request.method === "GET"
          ? { personal_wapps: [] }
          : { personal_wapp: { id: "personal-wapp-1" }, deleted: request.method === "DELETE" });
      }) as typeof fetch,
    });

    await client.listPersonalWapps("workspace-1", {
      ownerNpub: "npub1owner",
      includeArchived: true,
      limit: 200,
    });
    await client.createPersonalWapp("workspace-1", { title: "Launcher", launch_url: "https://app.example" });
    await client.updatePersonalWapp("workspace-1", "personal-wapp-1", { title: "Updated" });
    await client.archivePersonalWapp("workspace-1", "personal-wapp-1");

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps?owner_npub=npub1owner&include_archived=true&limit=200"],
      ["POST", "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps"],
      ["PATCH", "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps/personal-wapp-1"],
      ["DELETE", "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps/personal-wapp-1"],
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toMatch(/^Nostr /);
      expect(request.headers.get("x-flightdeck-pg-app-npub")).toBe("npub1flightdeck");
    }
  });

  test("broker hashes binary request bodies as their exact bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    let brokerPayload: Record<string, unknown> | null = null;
    const identity = createBotIdentityFromCapability({
      wingmanUrl: "http://wingman.test",
      sessionId: "session-binary",
      capabilityToken: "opaque-capability",
      botNpub: "npub1brokerbot",
      botPubkeyHex: "ab".repeat(32),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        brokerPayload = await request.json() as Record<string, unknown>;
        return Response.json({ token: "Nostr broker-signed-token", signedBy: "npub1brokerbot" });
      }) as typeof fetch,
    });
    if (!("signNip98" in identity)) throw new Error("expected broker identity");

    await identity.signNip98({ url: "http://tower.test/api/v4/storage/object", method: "PUT", body: bytes });

    expect(brokerPayload?.bodyHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("fails closed when broker signing identity disagrees with the injected session identity", async () => {
    const identity = createBotIdentityFromCapability({
      wingmanUrl: "http://wingman.test",
      sessionId: "session-mismatch",
      capabilityToken: "opaque-capability",
      botNpub: "npub1expected",
      botPubkeyHex: "ab".repeat(32),
      fetchImpl: (async () => Response.json({
        token: "Nostr broker-signed-token",
        signedBy: "npub1different",
      })) as typeof fetch,
    });
    if (!("signNip98" in identity)) throw new Error("expected broker identity");

    await expect(identity.signNip98({
      url: "http://tower.test/api/v4/flightdeck-pg/workspaces",
      method: "GET",
    })).rejects.toThrow(/does not match BOT_NPUB/);
  });
});
