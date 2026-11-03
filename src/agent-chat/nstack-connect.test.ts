import { describe, expect, test } from "bun:test";
import { connectNStackWorkspaces, validateNStackSelection, verifiedNStackDescriptor, type NStackWorkspaceConnection } from "./nstack-connect";
import type { WorkspaceSubscriptionManager } from "./subscription-runtime";

const connection: NStackWorkspaceConnection = {
  name: "Team", workspaceId: "workspace-1", workspaceOwnerNpub: "npub1owner",
  workspaceServiceNpub: "npub1workspace", directHttpsUrl: "https://tower.example", serviceNpub: "npub1tower",
};
function descriptor(input = connection) {
  return { type: "wingman_workspace_locator", tower_base_url: input.directHttpsUrl, label: input.name,
    identity: { tower_service_npub: input.serviceNpub, workspace_id: input.workspaceId,
      workspace_owner_npub: input.workspaceOwnerNpub, workspace_service_npub: input.workspaceServiceNpub, app_npub: "npub1app" } };
}
function fixture() {
  const records: any[] = [];
  const imports: any[] = [];
  const reconnects: string[] = [];
  const secrets: Uint8Array[] = [];
  let deniedWorkspace: string | null = null;
  let deniedAgent: string | null = null;
  const probes: string[] = [];
  const manager = {
    isAcceptedLegacyAudienceMember: () => false,
    listAgentsForManager: () => ["a", "b"].map((id) => ({ agentId: id, botNpub: id, label: id, enabled: true })),
    listBackendConnectionsForManager: () => [{ backendConnectionId: "backend", backendBaseUrl: connection.directHttpsUrl, serviceNpub: connection.serviceNpub }],
    listForManager: () => records,
    importAgentConnectPackage: async (input: any) => {
      imports.push(input);
      const locator = input.packageJson.workspace_descriptor;
      const record = { subscriptionId: `s${records.length}`, backendBaseUrl: connection.directHttpsUrl,
        agentProfileId: input.agentProfileId, workspaceId: locator.identity.workspace_id, sourceAppNpub: "npub1app", botNpub: input.agentProfileId,
        healthStatus: "healthy", lifecycleStatus: "active", sseStatus: "connected" };
      records.push(record);
      return { subscription: record };
    },
    reconnectForManager: async (id: string) => { reconnects.push(id); records.find((row) => row.subscriptionId === id).healthStatus = "healthy"; },
  } as unknown as WorkspaceSubscriptionManager;
  const input = { manager, managedByNpub: "manager", workspaces: [connection],
    resolveIdentity: async (npub: string) => {
      const botSecret = new Uint8Array(32).fill(7); secrets.push(botSecret);
      return { botNpub: npub, botPubkeyHex: "0".repeat(64), botSecret };
    },
    agentProfileId: null as string | null,
    fetchDescriptor: async ({ connection: selected, identity }: any) => {
      probes.push(identity.botNpub);
      if (selected.workspaceId === deniedWorkspace || identity.botNpub === deniedAgent) throw new Error("HTTP 403: membership required");
      return descriptor(selected);
    },
  };
  return { input, records, imports, reconnects, secrets, probes, denyWorkspace: (id: string | null) => { deniedWorkspace = id; }, denyAgent: (id: string) => { deniedAgent = id; } };
}

describe("consented NStack setup", () => {
  test("validates bounded root connections and never accepts credentials or alternate paths", () => {
    expect(() => validateNStackSelection([])).toThrow();
    for (const url of ["http://remote.example", "https://tower.example/api", "https://user:secret@tower.example", "https://tower.example/?token=key", "https://tower.example/#fragment"]) {
      expect(() => validateNStackSelection([{ ...connection, directHttpsUrl: url }])).toThrow();
    }
    expect(validateNStackSelection([{ ...connection, directHttpsUrl: "http://127.0.0.1:4000" }])[0]?.directHttpsUrl).toBe("http://127.0.0.1:4000");
    expect(() => validateNStackSelection([{ ...connection, serviceNpub: null }])).toThrow("serviceNpub");
  });
  test("pins all descriptor identities; accepts only same-host proxy HTTP advertisement", () => {
    expect(verifiedNStackDescriptor(connection, { ...descriptor(), tower_base_url: "http://tower.example" }).raw.tower_base_url).toBe(connection.directHttpsUrl);
    for (const url of ["https://other.example", "http://tower.example:4000", "https://tower.example/path", "https://tower.example:444", "https://tower.example/?x=y", "https://u@tower.example"]) {
      expect(() => verifiedNStackDescriptor(connection, { ...descriptor(), tower_base_url: url })).toThrow();
    }
    for (const field of ["workspace_id", "workspace_owner_npub", "workspace_service_npub", "tower_service_npub"]) {
      const raw = descriptor();
      expect(() => verifiedNStackDescriptor(connection, { ...raw, identity: { ...raw.identity, [field]: "other" } })).toThrow("identity");
    }
  });
  test("concurrent retries and duplicate display names reuse the chosen bot's subscription and connection", async () => {
    const f = fixture();
    f.input.agentProfileId = "a";
    f.input.workspaces = [connection, { ...connection, name: "Ambulando" }, { ...connection, name: "Flight Deck" }];
    const results = await Promise.all([connectNStackWorkspaces(f.input), connectNStackWorkspaces(f.input)]);
    expect(f.imports).toHaveLength(1);
    expect(f.records).toHaveLength(1);
    expect(results[0]?.results).toHaveLength(1);
    expect(results[1]?.results[0]?.status).toBe("monitoring");
    expect(f.imports.map((row) => row.agentProfileId)).toEqual(["a"]);
    expect(f.probes).not.toContain("b");
    expect(f.secrets.every((secret) => secret.every((byte) => byte === 0))).toBe(true);
  });
  test("without a chosen profile no local bot is probed or connected", async () => {
    const f = fixture();
    const result = await connectNStackWorkspaces(f.input);
    expect(result.results[0]).toMatchObject({ status: "failed", message: expect.stringContaining("Choose the bot profile") });
    expect(f.probes).toEqual([]);
    expect(f.imports).toEqual([]);
  });
  test("without a chosen profile only bots already serving the workspace are re-verified", async () => {
    const f = fixture();
    f.input.agentProfileId = "a";
    await connectNStackWorkspaces(f.input);
    f.input.agentProfileId = null;
    f.probes.length = 0;
    const result = await connectNStackWorkspaces(f.input);
    expect(result.results[0]?.status).toBe("monitoring");
    expect(f.probes).toEqual(["a"]);
    expect(f.imports).toHaveLength(1);
  });
  test("partial workspace failure can retry without disturbing successful agents", async () => {
    const f = fixture();
    f.input.agentProfileId = "a";
    f.input.workspaces.push({ ...connection, workspaceId: "workspace-2" });
    f.denyWorkspace("workspace-2");
    const first = await connectNStackWorkspaces(f.input);
    expect(first.results.map((row) => row.status)).toEqual(["monitoring", "failed"]);
    f.denyWorkspace(null);
    const second = await connectNStackWorkspaces(f.input);
    expect(second.results.map((row) => row.status)).toEqual(["monitoring", "monitoring"]);
    expect(f.imports).toHaveLength(2);
  });
  test("a chosen nonmember bot fails visibly without trying other bots", async () => {
    const f = fixture(); f.denyAgent("b");
    f.input.agentProfileId = "b";
    const result = await connectNStackWorkspaces(f.input);
    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[0]?.errors).toEqual(["b: HTTP 403: membership required"]);
    expect(f.probes).toEqual(["b"]);
    expect(f.imports).toHaveLength(0);
  });
  test("preserves paused/disconnected/revoked state; reconnects unhealthy active subscriptions", async () => {
    const f = fixture();
    for (const agentProfileId of ["a", "b"]) { f.input.agentProfileId = agentProfileId; await connectNStackWorkspaces(f.input); }
    f.input.agentProfileId = null;
    f.records[0].sseStatus = "disabled";
    f.records[1].healthStatus = "degraded";
    const result = await connectNStackWorkspaces(f.input);
    expect(result.results[0]?.status).toBe("preserved");
    expect(f.reconnects).toEqual(["s1"]);
    for (const lifecycleStatus of ["locally_disconnected", "revoked"]) {
      f.records[1].lifecycleStatus = lifecycleStatus;
      await connectNStackWorkspaces(f.input);
      expect(f.records[1].lifecycleStatus).toBe(lifecycleStatus);
    }
    expect(f.imports).toHaveLength(2);
  });
});
