import { describe, expect, test } from "bun:test";

import type { RuntimeBotIdentity } from "../agent-chat/types";
import type { WappRecord } from "./types";
import { buildFlightDeckWappRecordPayload, TowerPgWappPublisher } from "./wapp-publisher";

const authority: RuntimeBotIdentity = {
  botNpub: "npub1publisher",
  botPubkeyHex: "a".repeat(64),
  botSecret: new Uint8Array(32),
};

function wapp(overrides: Partial<WappRecord> = {}): WappRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    wappInstallationId: "00000000-0000-4000-8000-000000000001",
    appId: "app-4",
    title: "Publishing",
    description: "Tower launcher",
    ownerNpub: "npub1owner",
    createdByNpub: "npub1creator",
    workspaceOwnerNpub: "npub1workspace",
    scopeId: "scope-4",
    scopeLineage: { scopeId: "scope-4", l1Id: "l1", l2Id: null, l3Id: null, l4Id: null, l5Id: null },
    allowedNpubs: ["npub1owner", "npub1member"],
    launchUrl: "https://apps.example/publishing",
    sourceWingmanUrl: "https://wingman.example",
    subdomainAlias: null,
    towerBindingId: null,
    towerBinding: null,
    appNpub: null,
    publisherNpub: null,
    pendingPublisherNpub: null,
    registeredOpenOrigins: ["https://apps.example"],
    status: "active",
    schedule: null,
    recordState: "active",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    lastPublishedAt: null,
    ...overrides,
  };
}

function publisher(input: {
  existing?: Record<string, unknown> | null;
  calls: Array<{ method: string; args: unknown[] }>;
}) {
  return new TowerPgWappPublisher({
    defaultTowerUrl: "https://tower.example",
    authority,
    resolveSourceAppNpub: () => "npub1flightdeck",
    createClient: ({ towerUrl, sourceAppNpub, authority: signingAuthority }) => {
      expect(towerUrl).toBe("https://tower.example");
      expect(sourceAppNpub).toBe("npub1flightdeck");
      expect(signingAuthority).toBe(authority);
      return {
        listWorkspaces: async () => ({
          workspaces: [{ identity: { workspace_id: "workspace-1", workspace_owner_npub: "npub1workspace" } }],
        }),
        listPersonalWapps: async (...args) => {
          input.calls.push({ method: "GET", args });
          return { personal_wapps: input.existing ? [input.existing] : [] };
        },
        createPersonalWapp: async (...args) => {
          input.calls.push({ method: "POST", args });
          return { personal_wapp: { id: "personal-wapp-1" } };
        },
        updatePersonalWapp: async (...args) => {
          input.calls.push({ method: "PATCH", args });
          return { personal_wapp: { id: "personal-wapp-1" } };
        },
        archivePersonalWapp: async (...args) => {
          input.calls.push({ method: "DELETE", args });
          return { deleted: true };
        },
      };
    },
  });
}

describe("Tower PG WApp publisher", () => {
  test("creates a typed personal-WApp launcher when no remote record exists", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const record = wapp();
    const result = await publisher({ calls }).publish(
      buildFlightDeckWappRecordPayload(record, "npub1flightdeck"),
      record,
    );

    expect(result).toEqual({
      published: true,
      reference: "flightdeck-pg:workspace-1:personal-wapp:personal-wapp-1",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[0]?.args).toEqual(["workspace-1", {
      ownerNpub: "npub1workspace",
      includeArchived: true,
      limit: 200,
    }]);
    expect(calls[1]?.args).toEqual(["workspace-1", expect.objectContaining({
      owner_npub: "npub1workspace",
      scope_id: "scope-4",
      app_id: "app-4",
      wapp_id: record.id,
      wapp_installation_id: record.id,
      publisher_npub: null,
      registered_open_origins: ["https://apps.example"],
      status: "active",
    })]);
    expect((calls[1]?.args[1] as any).metadata.autopilot_wapp).toMatchObject({
      wapp_installation_id: record.id,
      publisher_npub: null,
      registered_open_origins: ["https://apps.example"],
    });
  });

  test("updates the existing typed personal-WApp launcher", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const record = wapp({ title: "Updated launcher" });
    const result = await publisher({
      calls,
      existing: { id: "personal-wapp-1", wapp_id: record.id, status: "active" },
    }).publish(buildFlightDeckWappRecordPayload(record, "npub1flightdeck"), record);

    expect(result.published).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]?.args).toEqual([
      "workspace-1",
      "personal-wapp-1",
      expect.objectContaining({ title: "Updated launcher", wapp_id: record.id }),
    ]);
  });

  test("archives the existing typed personal-WApp launcher", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const record = wapp({ status: "archived", recordState: "archived" });
    const result = await publisher({
      calls,
      existing: { id: "personal-wapp-1", wapp_id: record.id, status: "active" },
    }).publish(buildFlightDeckWappRecordPayload(record, "npub1flightdeck"), record);

    expect(result).toEqual({
      published: true,
      reference: "flightdeck-pg:workspace-1:personal-wapp:personal-wapp-1:archived",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(calls[1]?.args).toEqual(["workspace-1", "personal-wapp-1"]);
  });

  test("fails closed when Flight Deck application identity is missing", async () => {
    const record = wapp();
    const result = await new TowerPgWappPublisher({
      defaultTowerUrl: "https://tower.example",
      authority,
      resolveSourceAppNpub: () => null,
    }).publish(buildFlightDeckWappRecordPayload(record, "autopilot"), record);

    expect(result).toMatchObject({
      published: false,
      error: "wapp-publish-flightdeck-app-unavailable",
    });
  });
});
