import { describe, expect, test } from "bun:test";

import { registerTowerWappWithTower, TowerWappRegistrationError } from "./tower-registration";

const loadSigningHelpers = async () => ({
  signBotRequest: (params: { url: string; method: string; body: unknown }) => {
    return `Nostr signed:${params.method}:${params.url}:${JSON.stringify(params.body)}`;
  },
}) as never;

describe("Tower WApp registration client", () => {
  test("posts workspace app registration with bot NIP-98 auth", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const result = await registerTowerWappWithTower({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
      appNpub: "npub1app",
      wappInstallationId: "installation-1",
      publisherNpub: "npub1app",
      registeredOpenOrigins: ["https://wapp.example"],
      appName: "Ops Board",
      authority: {
        botNpub: "npub1bot",
        botPubkeyHex: "f".repeat(64),
        botSecret: new Uint8Array(32),
      },
    }, async (input, init) => {
      calls.push({ input, init });
      return Response.json({ app: { app_npub: "npub1app" } }, { status: 201 });
    }, loadSigningHelpers);

    expect(result).toMatchObject({ workspaceOwnerNpub: "npub1workspace", appNpub: "npub1app" });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://tower.example/api/v4/workspaces/npub1workspace/apps");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toContain("Nostr signed:POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      app_npub: "npub1app",
      app_name: "Ops Board",
      enabled: true,
      metadata: {
        wapp_installation_id: "installation-1",
        publisher_npub: "npub1app",
        registered_open_origins: ["https://wapp.example"],
      },
    });
  });

  test("surfaces Tower registration errors", async () => {
    await expect(registerTowerWappWithTower({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
      appNpub: "npub1app",
      wappInstallationId: "installation-1",
      publisherNpub: "npub1app",
      registeredOpenOrigins: ["https://wapp.example"],
      appName: "Ops Board",
      authority: {
        botNpub: "npub1bot",
        botPubkeyHex: "f".repeat(64),
        botSecret: new Uint8Array(32),
      },
    }, async () => Response.json({ error: "Not authorized to manage this workspace" }, { status: 403 }), loadSigningHelpers))
      .rejects.toBeInstanceOf(TowerWappRegistrationError);
  });
});
